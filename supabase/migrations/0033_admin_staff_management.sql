-- 0033_admin_staff_management.sql —— 後台人員管理頁的資料庫底座
--
-- 前一支是 0032_admin_order_notify.sql。既有 0001–0032 一律不動（規約：已套用
-- 的 migration 永不修改），所以要加的東西都用這一支新的來加。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 在補哪個洞
-- ═══════════════════════════════════════════════════════════════════════════
--
-- user 問「哪邊可以設定管理員與操作人員」——目前答案是「沒有地方，只能進
-- Supabase Dashboard 手改 profiles 表」。src/server/auth.ts 的檔頭就寫著
-- 「Accounts are created by hand in the Supabase dashboard」；更直接的證據是
-- src/routes/admin/pending.tsx：卡在待審狀態的人看到的字是「請聯絡管理員，
-- 把角色改成 staff」，畫面上沒有任何按鈕能做這件事。
--
-- 這一支負責資料庫那一半：一支「不可以移除最後一位 admin」的保護 trigger，
-- 以及兩支給後台人員管理頁用的 RPC。TypeScript 那一側（頁面、server fn、
-- repo）在同一個工作裡完成，不動資料庫一個字。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 參考台大農經官網（agec-web）的做法，只搬邏輯不搬程式碼
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 台大那邊是 Next.js Server Component + Server Action + 真的 Supabase Auth
-- session（RLS 用 auth.uid()），這裡是 TanStack Start server fn + 自製 cookie
-- session（見 src/server/session.ts）+ 全部經 service_role 寫入。元件寫法整套
--不同，這裡只搬兩件事的**邏輯**：
--
--   1. admin_users_keep_manager()（台大命名）—— AFTER STATEMENT trigger，
--      掛在 delete 與 update 上，統計「這個語句做完之後還有幾個管理員」，
--      0 就整個語句失敗。搬過來變成 profiles_keep_last_admin()，邏輯逐字
--      對應，只是把「admin_users 這張白名單表」換成「profiles 這張全站身分表」。
--
--   2. createUser() 的兩步驟＋回滾：GoTrue Admin API 建帳號 → 寫入角色；
--      第二步失敗就把第一步建好的帳號刪掉，不留孤兒帳號。這一半完全在
--      TypeScript 那一側（src/server/repos/staff-accounts.ts），這支 migration
--      不涉及。
--
-- ── ⚠️ 一個搬不過去的地方：auth.uid() 在這個站永遠是 null ──────────────────
--
-- 台大的 log_admin_change() 與 admin_users 的 RLS policy 都靠 auth.uid()：
-- 瀏覽器帶著真的 Supabase session JWT 直接打 PostgREST，RLS 用那個 JWT
-- 認人。這個站不是這樣運作的——0009 搬進來的舊進銷存схема 裡雖然還留著
-- 5 處 auth.uid()（inv.* 的舊 policy，來源系統遺跡，0010 起已經不是真正在
-- 生效的授權模型），但 0010 之後**唯一**的授權路徑是：瀏覽器只拿得到
-- anon key，真正的讀寫都經 supabaseAdmin()（service_role，見
-- src/server/supabase-admin.ts）在伺服器端執行，身分則來自
-- src/server/session.ts 簽的 httpOnly cookie，不是 Supabase Auth 的 JWT。
-- service_role 打 SQL 時 auth.uid() 一律是 null。
--
-- 所以下面的 admin_update_profile_role() 沒辦法像台大那樣自己用 auth.uid()
-- 認出「是誰在改」，只能讓呼叫端（已經通過 requireAdmin() 的 server fn）把
-- 「操作者是誰」當一個參數傳進來——與這個站現有每一支需要 userId 的 RPC
-- 是同一個信任模型（例如 src/lib/admin/fns/inv-adjustments.ts 把
-- context.staff.userId 當參數傳給 saveAdjustment()）。這代表這支函式的
-- 「不能改自己」保護，正確性完全依賴呼叫端誠實——而呼叫端就是這一支
-- migration 同一個工作裡新增的 server fn，且這支 RPC 從 anon/authenticated
-- 撤權（見 §3），瀏覽器不可能繞過 TypeScript 層直接偽造 p_actor_id。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 為什麼 AFTER STATEMENT，不是 BEFORE ROW（與台大同一個理由，這裡重新推一次）
-- ═══════════════════════════════════════════════════════════════════════════
--
-- BEFORE ROW 看到的是「這一列還沒被改」的狀態，所以一次刪光兩個 admin 的
-- `delete from profiles where role = 'admin'` 在處理第一列時，資料庫裡「還有
-- 一個」admin（第二列還沒被刪），trigger 會誤判成安全而放行，刪完才發現
-- 兩個都不見了。AFTER STATEMENT 在整個語句做完、所有列都改完之後才檢查，
-- 才是真的「這個語句做完之後還剩幾個」。
--
-- 同時掛 delete 與 update：把最後一位 admin **降級成 staff／pending／customer**
-- 造成的後果與刪掉他的 profiles 列一模一樣（後台再也沒有人能管人），只擋
-- delete 會留下一條繞過去的路。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ profiles 不是白名單表，是全站的身分表——這一條的影響範圍要交代清楚
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 台大的 admin_users 只有後台人員（幾筆到十幾筆）。這個站的 public.profiles
-- 是**每一個註冊帳號**的身分列——顧客、廠商、店員、管理員全部在同一張表
-- （0010 §1 放寬的那個值域：customer/pending/staff/vendor/admin）。AFTER
-- STATEMENT trigger 掛在整張表上，任何一次 update／delete（不管改的是不是
-- admin 那幾列）都會觸發它去數一次「現在還有幾個 admin」。
--
-- 這在理論上放大了風險範圍：如果這張表哪天真的進到「零個 admin」的狀態，
-- 之後**任何一筆**顧客資料的 update／delete 都會被這個 trigger 擋下來——
-- 不只是動到 admin 那幾列的語句。但目前這個風險不成立，理由是：
--
--   1. 全 repo 目前沒有任何一支程式對 profiles 做 update／delete（見這個
--      工作的委派說明；三處 `.from("profiles")` 都是唯讀，出自
--      src/server/auth.ts、src/server/vendor-auth.ts、
--      src/server/repos/inv-vendors.ts）——這支 migration套用之後，
--      profiles 唯一的寫入路徑就是這支工作新增的後台人員管理頁。
--   2. 正式庫此刻已經有兩位 admin（0010 §1.4 匯入時的 zin@fans.tw 與
--      alice，見 scripts/inventory-migration-selftest.mjs 的 EXPECTED_ROLES）。
--      這支 trigger 一旦套用，「降到 0 個 admin」這件事本身就再也發生不了
--      （不管是 delete 還是 update 都會被擋），所以「已經 0 個 admin、
--      殃及顧客資料」這個狀態從此不可達——起點是 ≥1，而這支 trigger
--      保證只要有 ≥1 就永遠不會变成 0。
--   3. handle_new_user()（0002）在 auth.users 新增時 insert 一列 profiles，
--      這支 trigger 完全不擋 insert——顧客正常註冊、店員被建立帳號都不受
--      影響，只有 update／delete 會被它看到。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 這一支不動 0001–0032 的任何表或函式，只新增
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 沒有 alter 打在既有的 profiles 欄位或既有的 staff_permissions 欄位上
-- （0010 的 CHECK、0019／0021 對 staff_permissions.permission 的 CHECK 都
-- 原樣保留），也沒有 drop 任何既有物件。新增的三個物件（一支 trigger 函式、
-- 一個 trigger、兩支 RPC）名字都是全新的，見前面「命名檢查」的搜尋結果。

begin;

-- ---------------------------------------------------------------------------
-- §1  profiles_keep_last_admin() —— 保底：至少要留一位 admin
-- ---------------------------------------------------------------------------
-- 邏輯逐字對應台大 admin_users_keep_manager()：statement 做完後數一次
-- role='admin' 還剩幾個，0 就整句失敗。應用層（src/server/repos/
-- staff-accounts.ts）也會擋（不能移除／降級最後一位、不能改自己），但這種
-- 「一旦發生就沒有人救得回來」的狀態值得在資料庫再擋一次——與這個站其他
-- 「應用層寫錯時讓交易失敗，而不是讓系統進入沒有出口的狀態」的既有先例
-- （例如 0011 的庫存不可超賣檢查）同樣的用意。
--
-- SECURITY DEFINER：對這個站現在的情況（profiles 只有 service_role 摸得到，
-- RLS 開著但零 policy——見 0002 §1 的 revoke all + grant service_role）其實
-- 不是必要的，因為 service_role 本來就繞過 RLS，這支函式不管是不是
-- DEFINER，count(*) 看到的都是全表。保留 DEFINER 只是跟這個站其餘每一支
-- trigger／RPC（handle_new_user、admin_reorder_*、
-- enqueue_admin_order_email……）維持同一個寫法，並且作為防呆：未來如果有人
-- 在 profiles 上加了 RLS policy，這支函式的正確性不會被那個改動意外影響。
create or replace function public.profiles_keep_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.profiles where role = 'admin') = 0 then
    raise exception 'LAST_ADMIN';
  end if;
  return null;
end;
$$;

comment on function public.profiles_keep_last_admin() is
  '保底：profiles 裡至少要留一位 role=admin，否則後台再也沒有人能管人、開帳號。AFTER STATEMENT 觸發，掛在 delete 與 update 上——降級跟刪除的後果一樣，都要擋。不擋 insert：正常註冊與建立新帳號不受影響。';

drop trigger if exists profiles_keep_last_admin on public.profiles;
create trigger profiles_keep_last_admin
  after delete or update on public.profiles
  for each statement execute function public.profiles_keep_last_admin();

-- ---------------------------------------------------------------------------
-- §2  admin_update_profile_role() —— 後台人員管理頁改角色的唯一入口
-- ---------------------------------------------------------------------------
-- 三件事在一次呼叫裡做完，理由是「不能改自己」與「不能清空 admin」都是
-- 一致性規則，塞進同一個 plpgsql 函式（＝同一個交易）比在 TypeScript 那一側
-- 分兩次呼叫更難被競態繞過去：
--
--   1. p_new_role 必須是 pending / staff / admin / customer 之一。
--      🔴 刻意排除 vendor，即使 profiles.role 的 CHECK（0010 §1）本身允許
--      它——vendor 是廠商自助入口（0019）的身分，跟這一頁「後台人員」是
--      完全不同的授權面。這支 RPC 是後台人員管理頁**唯一**的改角色入口，
--      在這裡擋住 vendor，就等於整頁都做不出「把人設成 vendor」這件事，
--      不必依賴 TypeScript 那一層記得檢查。
--      也排除任何 CHECK 值域以外的字串——但那件事 CHECK 本身已經會擋，
--      這裡重複列出「有效值只有這四個」單純是把這支 RPC 自己的業務規則
--      講清楚，跟 0010 §1 的值域是兩件事：CHECK 定義「這個欄位允許存在
--      的值」，這裡定義「這支 RPC 願意幫你設的值」，後者是前者的子集。
--   2. p_actor_id 不可以等於 p_target_id——管理員不能改自己的角色，理由
--      見檔頭「auth.uid() 永遠是 null」那一段：這條保護的正確性依賴呼叫端
--      誠實傳入操作者 id，而呼叫端（server fn）已經通過 requireAdmin()。
--   3. 執行 update；上面 §1 的 trigger 會在這次 update 做完後自動檢查一次
--      「還有沒有 admin」——這支函式不重複那個邏輯，只負責前面兩條跟角色
--      改動本身相關、trigger 管不到的規則。
--
-- returns public.profiles：回整列而不是 void，讓呼叫端（server fn）不必再
-- 補一次 select 就能把最新狀態吐回前端更新畫面。
create or replace function public.admin_update_profile_role(
  p_actor_id  uuid,
  p_target_id uuid,
  p_new_role  text
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.profiles;
begin
  if p_new_role not in ('pending', 'staff', 'admin', 'customer') then
    raise exception 'INVALID_ROLE';
  end if;

  if p_actor_id = p_target_id then
    raise exception 'CANNOT_CHANGE_OWN_ROLE';
  end if;

  update public.profiles
     set role = p_new_role
   where id = p_target_id
  returning * into v_row;

  if not found then
    raise exception 'PROFILE_NOT_FOUND';
  end if;

  return v_row;
end;
$$;

comment on function public.admin_update_profile_role(uuid, uuid, text) is
  '後台人員管理頁改角色的唯一入口。p_new_role 只接受 pending/staff/admin/customer（🔴 不含 vendor——那是廠商入口的身分，這支刻意不讓它從這裡被設出來）。p_actor_id = p_target_id 會被拒絕（不能改自己）。「不能清空 admin」由 profiles_keep_last_admin trigger 在同一個交易裡處理，這支不重複那段邏輯。p_actor_id 由呼叫端（已通過 requireAdmin() 的 server fn）傳入，這支本身不驗證身分——見本檔案檔頭「auth.uid() 永遠是 null」的說明。';

-- ---------------------------------------------------------------------------
-- §3  admin_replace_staff_permissions() —— 整批覆蓋一個人的細權限
-- ---------------------------------------------------------------------------
-- 「先刪光、再整批插入」如果在 TypeScript 那一側分兩次呼叫（先
-- .delete()，再 .insert()），中間任何一次網路失敗都會讓那個人的權限**靜默
-- 變成空的**——不是回到修改前的樣子，是介於兩者之間、沒有人設計過的狀態。
-- 包成一支 plpgsql 函式讓 delete 與 insert 落在同一個交易裡，要嘛全部生效、
-- 要嘛整個回滾，不會有「刪了但插入失敗」的中間態。
--
-- p_permissions 允許空陣列（unnest('{}'::text[]) 是空集合，insert…select
-- 自然插入 0 列）——把一個人的權限全部收回，本來就是合理操作。
--
-- 不驗證 p_permissions 的每個元素是不是九種合法權限之一：
-- staff_permissions.permission 的 CHECK（0021 §4，九種值域）本身就會擋，
-- 讓資料庫的錯誤處理走同一條路，不在這裡重複一份可能跟 CHECK 值域各自
-- 漂移的清單。
--
-- p_granted_by 比照 0010 §2 對 granted_by 的設計（可為 null，on delete set
-- null），這裡不是 nullable 參數，而是由呼叫端一律傳入目前操作的管理員 id
-- ——之後若那位管理員被刪除，既有紀錄的 granted_by 會如欄位定義變成 null，
-- 不影響已授出的權限本身。
create or replace function public.admin_replace_staff_permissions(
  p_user_id     uuid,
  p_permissions text[],
  p_granted_by  uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.staff_permissions where user_id = p_user_id;

  insert into public.staff_permissions (user_id, permission, granted_by)
  select p_user_id, perm, p_granted_by
    from unnest(coalesce(p_permissions, '{}'::text[])) as perm;
end;
$$;

comment on function public.admin_replace_staff_permissions(uuid, text[], uuid) is
  '整批覆蓋一個人的 staff_permissions：同一個交易內先刪光再插入，避免「刪了但插入失敗」的中間態。不驗證權限字串是否合法——staff_permissions.permission 的 CHECK（0021 §4）本身會擋。空陣列＝把權限全部收回。';

-- ---------------------------------------------------------------------------
-- §4  權限——SECURITY DEFINER，處理方式同 0032 §3
-- ---------------------------------------------------------------------------
-- execute 預設會 grant 給 public，所以「從 public revoke」才是真正生效的那一
-- 半，anon / authenticated 是保險（它們是 public schema 的函式，PostgREST
-- 會把它們當 RPC 端點暴露出去——不撤權的話，任何人都能用瀏覽器就看得到的
-- anon key 直接呼叫 admin_update_profile_role，並且**自己填 p_actor_id**，
-- 完全繞過「不能改自己」那個檢查與 requireAdmin() 的授權，直接把任何一個
-- 帳號（包括自己控制的另一個帳號）的角色改成 admin。這是這支 migration
-- 裡後果最嚴重的一步撤權，必須跟 admin_replace_staff_permissions 一起做到。
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.admin_update_profile_role(uuid, uuid, text)',
    'public.admin_replace_staff_permissions(uuid, text[], uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public', sig);
    execute format('revoke execute on function %s from anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end loop;
end $$;

commit;
