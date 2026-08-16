-- 0019_vendors_pii_portal.sql —— 廠商主檔、PII 治理，以及廠商自助入口
--
-- 0016 讓店員維護商品，0017 讓庫存動起來，0018 補上套餐與二手書。這一份處理
-- 整個 inv schema 裡**最敏感的一張表**，並且第一次讓「非店員」的身分碰到 inv 的
-- 資料。
--
-- 前一個 migration：0018_inventory_combos_secondhand.sql。既有 0001–0018 一律
-- 不動（0009／0011／0016／0018 自己的檔頭也是這樣宣告的），要改行為就在這裡
-- `create or replace` / `alter table`。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0  為什麼這一期的重點不是搬 UI
-- ═══════════════════════════════════════════════════════════════════════════
--
-- inv.vendors 有 48 欄，其中 id_number（身分證字號）、foreign_id、
-- residence_permit_number、tax_id，加上 inv.vendor_bank_accounts.account_number
-- （銀行帳號）—— 這五個欄位就是 0009 §0 決定把整個 inv schema 移出 PostgREST
-- 可達範圍的原因。0016 §5c 只開六欄給商品頁的下拉選單，並且在註解裡寫死了一句
-- 「要加欄位之前先問：這一欄出現在瀏覽器裡會怎樣」。
--
-- 這一期要做廠商後台，等於要把那 48 欄搬到畫面上；還要做廠商自助入口，等於要讓
-- 一個**不是店員**的人登入之後讀到 inv 的資料。兩件事加起來，「哪些欄位、誰、
-- 什麼時候看過」這個問題第一次變成需要有答案的問題。
--
-- 所以這個檔案的核心不是 CRUD，是三條規矩：
--
--   1. **預設看不到完整號碼。** 日常的清單與表單一律走遮罩過的 view
--      （`A******89`、`****1234`）。不是「權限不夠時遮起來」，是**沒有任何一個
--      view 送得出完整值** —— 遮罩寫在 view 的 select list 裡，不是寫在前端。
--
--   2. **看完整值只有一條路，而且那條路一定留痕。** public.inv_vendor_sensitive()
--      是唯一讀得到原值的地方，它在回傳之前**先寫一筆 public.pii_access_log**，
--      同一個交易。讀成功 ⇔ 有紀錄，兩者不可能分開（§1 有詳細推導）。
--
--   3. **稽核軌跡自己不可以變成新的外洩面。** pii_access_log 累積的是「誰看了誰
--      的身分證」這種後設資料 —— 它比 vendors 本身更敏感，所以它的權限比 vendors
--      更嚴，而且**任何人都刪不掉自己的紀錄**（§1.3 是結構上做不到，不是靠規定）。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0.1  廠商自助入口：vendor_id 一律來自 session，不接受 client 傳
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 舊網站 v3 有一套「藝術家自助入口」，它的權限模型有兩個洞（兩個都已當面確認）：
--
--   洞一：`private.is_admin()` 只檢查「這個 user 在不在 admin_users 裡」，**不看
--         role**。於是一個 role='artist' 的帳號在 DB 層對所有內容表有完整 CRUD，
--         而且讀得到全部 inquiries。側欄只是把選單藏起來，改網址就繞過。
--
--   洞二：`artists.user_id` 沒有 UNIQUE，而 `my_artist_id()` 是 `LIMIT 1`。同一個
--         user 對到兩列 artists 時，「你是哪一位藝術家」由 heap 掃描順序決定 ——
--         跟 0018 §問題一的「第一件」是同一種病。
--
-- 這一版對這兩個洞的處理：
--
--   洞一 → **結構上消失**。這個專案沒有「瀏覽器直接打資料庫」這條路（inv 不在
--          PostgREST 的 db_schema 裡，public 的每一張後台表都是 RLS 開著、零
--          policy、只有 service_role 進得來）。所以「policy 判斷寫錯」這一整類
--          問題沒有作用對象。授權在 server fn 的 middleware，見
--          src/lib/admin/middleware.ts。§7.2 的 vendor_users 也刻意**不帶 role**
--          —— 它只回答「這個帳號是哪一家廠商」，不回答「他能做什麼」，後者是
--          server fn 的事。一個資料表同時回答兩個問題，正是洞一的成因。
--
--   洞二 → **補 UNIQUE**，而且是用 PRIMARY KEY 補的：public.vendor_users 的主鍵
--          就是 user_id，一個帳號結構上只能對到一家廠商。§8 的 public.artists
--          也對 vendor_id 加 UNIQUE，同一條理由。
--
-- 由此推出這個檔案裡每一支「廠商可以呼叫」的函式的簽名長相：
--
--     public.inv_vendor_submit_product(p_user_id uuid, p_payload jsonb)
--                                      ^^^^^^^^^
--     **沒有 p_vendor_id 這個參數。**
--
-- vendor_id 在函式體內用 p_user_id 查 public.vendor_users 得到。呼叫端就算想傳
-- 別家的 id 也沒有地方可以傳 —— 不是「我們有檢查」，是那個參數不存在。
-- （p_user_id 本身來自 sealed cookie，見 src/server/vendor-auth.ts。）
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0.2  approve_vendors 是關著的 —— 查清楚了，是人為關的，而且不影響入口
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 4c 交接時留下一個問題：inv.approval_settings 裡 vendors 與 combo_sets 都是
-- is_enabled = false，這是有意的還是忘了開？
--
-- 查正式庫的 updated_at 就答得出來：其餘五個模組全部是 2026-03-23T02:35:41.754
-- （同一秒，那是初始化那一批），vendors 是 04:55:01.967，combo_sets 是
-- 02:57:35.65。三個不同的時間戳 = 有人在系統跑起來之後**分兩次手動關掉**的。
-- 不是漏設，是決定。（現況也對得上：14 家廠商全部 approval_status='approved'。）
--
-- 那為什麼廠商入口還是可以做？因為**廠商送審的東西不走 approval_settings**。
--
--   · approval_settings 回答的是「我信不信我自己的店員」。店員建一家廠商要不要
--     再找人簽核，那是店裡的內控鬆緊，老闆有權調鬆。
--   · 廠商送進來的商品是**外部投稿**。它要不要審核跟「我信不信我的店員」無關。
--
-- 所以 §7.4 的 inv_vendor_submit_product() **寫死 'pending'**，不呼叫
-- inv.initial_approval_status()。就算哪天有人把 approval_settings.products 也關掉
-- （現在是開著的），廠商送進來的商品仍然是待審核。這一條有測試守著。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0.3  這個檔案還順手收掉四件 4c 留下的資料完整性缺口
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 「廠商解約，把他的東西刪一刪」是這一期一定會被按下去的按鈕，而目前的外鍵讓
-- 那個按鈕會**靜默地**破壞四種東西。§6 把四條外鍵從「安靜地弄壞」改成「擋下來
-- 並說為什麼」。詳細推導在 §6 的註解裡。
--
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ---------------------------------------------------------------------------
-- §1  public.pii_access_log —— 稽核軌跡
-- ---------------------------------------------------------------------------
--
-- ── §1.1  為什麼記錄本身要比被記錄的資料更敏感 ───────────────────────────
--
-- 這張表存的不是身分證字號，是「誰在什麼時候看了誰的身分證字號」。它比
-- inv.vendors 更敏感，理由有兩層：
--
--   · vendors 洩漏 = 14 家廠商的身分資料外流。pii_access_log 洩漏 = 上面那件事
--     **再加上**每一位員工的查閱行為軌跡（誰在查誰、查得多勤、離職前一週查了
--     什麼）。後者是員工的個資，而且是連當事人自己都不會預期被留存的那種。
--   · 它同時是**追責的唯一證據**。可以被竄改的證據不是證據。
--
-- 所以這張表的權限比 vendors 更嚴：
--
--     inv.vendors            service_role 可以 select/insert/update/delete
--     public.pii_access_log  **沒有任何 role 拿得到直接 DML 權限**
--
-- 讀寫各只有一條路，兩條都是 SECURITY DEFINER 函式（§1.4／§1.5）。
--
-- ── §1.2  欄位為什麼長這樣 ───────────────────────────────────────────────
--
-- 「誰、什麼時候、看了哪一筆、看了哪些欄位」是任務書的四個問題，對應
-- actor_user_id / accessed_at / (subject_table, subject_id) / fields。
--
-- 另外三欄不是裝飾：
--   · actor_email —— 冗餘的，故意的。auth.users 刪掉之後 actor_user_id 會變成
--     一個查不到人的 uuid，那時候稽核軌跡就廢了。這裡在寫入當下把 email 抄一份
--     下來，讓紀錄脫離 auth.users 也還讀得懂。
--   · subject_label —— 同理，抄一份廠商名稱。廠商刪掉之後還要看得出當時看的是誰。
--   · access_kind —— 'staff' 是店員查廠商；'self' 是廠商在自助入口看自己的資料。
--     兩者都要記，但混在一起看會讓「有沒有人在亂查」這個問題失焦（自助入口每次
--     開啟都會產生一筆 self）。
--
create table if not exists public.pii_access_log (
  id            uuid primary key default gen_random_uuid(),
  accessed_at   timestamptz not null default now(),

  actor_user_id uuid not null,
  actor_email   text not null,
  access_kind   text not null default 'staff'
                check (access_kind in ('staff', 'self')),

  -- 目標。subject_table 是白名單而不是自由文字：它決定了下面 fields 的合法值域，
  -- 打錯字會變成一筆永遠對不到任何東西的紀錄，而且不會有人發現
  -- （與 0010 對 staff_permissions.permission 加 CHECK 是同一條理由）。
  subject_table text not null
                check (subject_table in ('inv.vendors', 'inv.vendor_bank_accounts')),
  subject_id    uuid not null,
  subject_label text,

  -- 看了哪些欄位。空陣列不算 —— 「讀了一筆但沒讀任何欄位」不是一件會發生的事，
  -- 出現就代表呼叫端有 bug，讓它在寫入當下就炸掉，而不是留一筆說不清楚的紀錄。
  fields        text[] not null
                check (array_length(fields, 1) >= 1),

  -- 為什麼要看。目前是 UI 上的下拉選單（對帳／匯款／報稅／廠商查詢），不是自由
  -- 文字 —— 自由文字最後一定變成空字串。
  reason        text not null
                check (reason in ('reconciliation', 'payment', 'tax_filing', 'vendor_enquiry', 'self_service')),

  created_at    timestamptz not null default now()
);

comment on table public.pii_access_log is
  '誰在什麼時候看了哪一筆廠商的哪些敏感欄位。append-only：沒有任何 role 有 INSERT/UPDATE/DELETE 權限，寫入只能經 public.pii_log_access()，而 UPDATE/DELETE 連 table owner 都被 trigger 擋住。';
comment on column public.pii_access_log.actor_email is
  '寫入當下抄一份。auth.users 那一列被刪掉之後，actor_user_id 會變成查不到人的 uuid —— 稽核軌跡不能依賴另一張表還活著。';
comment on column public.pii_access_log.subject_label is
  '寫入當下抄一份廠商名稱。理由同 actor_email。';
comment on column public.pii_access_log.access_kind is
  'staff=店員查廠商｜self=廠商在自助入口看自己的資料。兩者都記，但分開才看得出「有沒有人在亂查」。';
comment on column public.pii_access_log.fields is
  '這一次實際回傳了哪些欄位。不是「請求了哪些」—— 是「送出去了哪些」。';

create index if not exists pii_access_log_actor_idx
  on public.pii_access_log (actor_user_id, accessed_at desc);
create index if not exists pii_access_log_subject_idx
  on public.pii_access_log (subject_table, subject_id, accessed_at desc);
create index if not exists pii_access_log_time_idx
  on public.pii_access_log (accessed_at desc);

-- ── §1.3  append-only，而且是結構上的 ────────────────────────────────────
--
-- 兩道獨立的門，缺一不可：
--
--   門一（權限）：revoke 掉所有 role 的所有權限。Supabase 對 public schema 有
--                 ALTER DEFAULT PRIVILEGES，**新建的表一出生就對 anon /
--                 authenticated / service_role 是 ALL** —— 0013 就是在修這個坑。
--                 這裡連 service_role 都 revoke：service_role 是這個應用唯一的
--                 資料庫身分，它拿不到 DELETE 就代表應用程式碼裡不可能有一行
--                 刪得掉這張表。
--
--   門二（trigger）：門一擋不住 table owner（postgres）。Supabase Dashboard 的
--                    SQL Editor 就是用 owner 身分跑的 —— 也就是說，門一擋得住
--                    程式，擋不住「有人打開 dashboard 手動刪掉自己昨天的紀錄」。
--                    這個 trigger 擋的正是那件事。
--
-- ⚠️ 這個 trigger **沒有留任何 in-band 的繞道**（沒有 `IF current_setting(...)
--    THEN RETURN` 那種開關）。留了就等於留了一把鑰匙，而任何拿得到 service_role
--    的人都能撿到那把鑰匙。真的需要清理時，正確做法是明確地
--    `alter table public.pii_access_log disable trigger pii_access_log_immutable`
--    —— 那是一個需要 owner 權限、寫在 DDL 稽核裡、而且沒辦法假裝是日常操作的動作。
--
-- ⚠️ 也**刻意沒有保留期限**。§9 的 ocr-scans 有保留期限，這張表沒有 —— 兩者不同：
--    掃描圖是「原始個資的副本」，留越久風險越大；稽核軌跡是「查閱行為的證據」，
--    刪掉等於銷毀證據。個資法要的是前者最小化、後者可追溯。
create or replace function public.pii_access_log_immutable()
returns trigger
language plpgsql
as $$
BEGIN
  RAISE EXCEPTION 'PII_LOG_IMMUTABLE: 稽核軌跡不可修改或刪除（表 %，動作 %）',
                  TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

comment on function public.pii_access_log_immutable() is
  'pii_access_log 的 UPDATE/DELETE/TRUNCATE 一律擋下。刻意沒有繞道開關 —— 留一個開關等於留一把任何人都撿得到的鑰匙。';

-- trigger 函式不需要被任何人直接呼叫（trigger 是由表在 owner 的權限下觸發的），
-- 所以照樣 revoke。與這個檔案裡其餘每一支函式同一條規矩，沒有例外。
revoke execute on function public.pii_access_log_immutable() from public;
revoke execute on function public.pii_access_log_immutable() from anon, authenticated;

drop trigger if exists pii_access_log_immutable on public.pii_access_log;
create trigger pii_access_log_immutable
  before update or delete on public.pii_access_log
  for each row execute function public.pii_access_log_immutable();

drop trigger if exists pii_access_log_no_truncate on public.pii_access_log;
create trigger pii_access_log_no_truncate
  before truncate on public.pii_access_log
  for each statement execute function public.pii_access_log_immutable();

alter table public.pii_access_log enable row level security;

-- 連 service_role 都不給。寫走 §1.4，讀走 §1.5。
revoke all on table public.pii_access_log from anon, authenticated;
revoke all on table public.pii_access_log from service_role;
revoke all on table public.pii_access_log from public;

-- ── §1.4  寫入的唯一入口 ─────────────────────────────────────────────────
--
-- ⚠️ 這一支是 `security definer`，owner 是 postgres，所以它寫得進去而呼叫者
--    寫不進去。這正是「只能經由這裡寫入」的實作方式。
--
-- ⚠️ 它**不回傳任何敏感值**，只回傳 log id。取值是 §4 的事 —— 兩件事分開寫，
--    是為了讓「取值那一支一定先呼叫這一支」變成一行讀得出來的程式，而不是一段
--    要通篇讀完才確定的邏輯。
create or replace function public.pii_log_access(
  p_actor_user_id uuid,
  p_actor_email   text,
  p_subject_table text,
  p_subject_id    uuid,
  p_subject_label text,
  p_fields        text[],
  p_reason        text,
  p_access_kind   text default 'staff'
)
returns uuid
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_id uuid;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'PII_LOG_NO_ACTOR: 稽核紀錄必須有操作人員';
  END IF;
  IF p_subject_id IS NULL THEN
    RAISE EXCEPTION 'PII_LOG_NO_SUBJECT: 稽核紀錄必須有對象';
  END IF;
  IF p_fields IS NULL OR array_length(p_fields, 1) IS NULL THEN
    RAISE EXCEPTION 'PII_LOG_NO_FIELDS: 稽核紀錄必須寫明看了哪些欄位';
  END IF;

  INSERT INTO public.pii_access_log (
    actor_user_id, actor_email, access_kind,
    subject_table, subject_id, subject_label,
    fields, reason
  ) VALUES (
    p_actor_user_id,
    coalesce(nullif(btrim(p_actor_email), ''), '(未知)'),
    coalesce(p_access_kind, 'staff'),
    p_subject_table,
    p_subject_id,
    nullif(btrim(coalesce(p_subject_label, '')), ''),
    p_fields,
    p_reason
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

comment on function public.pii_log_access(uuid, text, text, uuid, text, text[], text, text) is
  '寫一筆 PII 查閱紀錄。這是 pii_access_log 唯一的寫入路徑（表本身對所有 role 零權限）。';

revoke execute on function public.pii_log_access(uuid, text, text, uuid, text, text[], text, text) from public;
revoke execute on function public.pii_log_access(uuid, text, text, uuid, text, text[], text, text) from anon, authenticated;
grant  execute on function public.pii_log_access(uuid, text, text, uuid, text, text[], text, text) to service_role;

-- ── §1.5  讀取 ───────────────────────────────────────────────────────────
--
-- security_invoker = false（與其餘 inv_admin_* 一致）：view 用 owner 的身分讀表，
-- 所以 §1.3 對 service_role 的 revoke 不會把這個 view 一起關掉。
--
-- ⚠️ 「誰讀得到這個 view」不在這裡決定，在 src/lib/admin/fns/inv-vendors.ts —— 它
--    要求 role='admin'。**店員即使有 inv.vendor.pii.read 也看不到稽核軌跡**：
--    看得到別人的查閱紀錄跟看得到廠商資料是兩種權限，把它們綁在一起等於讓每一個
--    查得到身分證的人同時查得到同事的查閱習慣。
create or replace view public.inv_admin_pii_access_log
with (security_invoker = false) as
select
  l.id             as log_id,
  l.accessed_at    as accessed_at,
  l.actor_user_id  as actor_user_id,
  l.actor_email    as actor_email,
  l.access_kind    as access_kind,
  l.subject_table  as subject_table,
  l.subject_id     as subject_id,
  l.subject_label  as subject_label,
  l.fields         as fields,
  l.reason         as reason
from public.pii_access_log l;

comment on view public.inv_admin_pii_access_log is
  'PII 查閱紀錄（唯讀）。只給 service_role，而且 server fn 那一層要求 role=admin —— 有 pii.read 的店員讀不到這裡。';

revoke all    on public.inv_admin_pii_access_log from anon, authenticated;
grant  select on public.inv_admin_pii_access_log to service_role;

-- ---------------------------------------------------------------------------
-- §2  遮罩
-- ---------------------------------------------------------------------------
--
-- 遮罩寫在資料庫，不寫在前端。理由與 0016 §2 把 initial_approval_status 從瀏覽器
-- 搬進資料庫一模一樣：在前端遮罩的意思是「完整值已經送到瀏覽器了，只是畫面上
-- 沒印出來」—— 而那個值會躺在 JSON response、React 的 props、devtools、以及任何
-- 一個 error reporting SDK 的 breadcrumb 裡。
--
-- 尾碼保留幾位是有取捨的：留太少，店員對不出「是不是這一家」；留太多，就等於
-- 沒遮。這裡的口徑是「夠對帳，不夠冒用」：
--
--   身分證字號 A123456789 → A*******89   （首碼 1 + 尾 2）
--   統一編號   12345678   → ******78     （尾 2）
--   銀行帳號   1234567890 → ******7890   （尾 4，對帳單上通常也只印後四碼）
--
create or replace function inv.mask_tail(p_value text, p_keep_tail integer, p_keep_head integer default 0)
returns text
language sql
immutable
as $$
  select case
           when p_value is null then null
           when btrim(p_value) = '' then null
           -- 太短的值不遮尾碼 —— 留 2 碼的規則套在 3 碼的值上等於沒遮。
           when length(btrim(p_value)) <= (p_keep_tail + p_keep_head) then repeat('*', length(btrim(p_value)))
           else
             left(btrim(p_value), p_keep_head)
             || repeat('*', length(btrim(p_value)) - p_keep_tail - p_keep_head)
             || right(btrim(p_value), p_keep_tail)
         end;
$$;

comment on function inv.mask_tail(text, integer, integer) is
  '遮罩。值太短時整串變星號（留尾規則套在短值上等於沒遮）。空字串一律回 NULL —— 讓「沒填」與「填了但看不到」在畫面上長得不一樣。';

revoke execute on function inv.mask_tail(text, integer, integer) from public;
revoke execute on function inv.mask_tail(text, integer, integer) from anon, authenticated;
grant  execute on function inv.mask_tail(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- §2.5  public.vendor_users —— 「這個帳號是哪一家廠商」
-- ---------------------------------------------------------------------------
--
-- 表建在這裡（而不是跟自助入口的其他東西一起放在 §7）只有一個原因：§3.1 的列表
-- view 要 join 它，好在廠商列表上顯示「這一家有沒有開自助入口帳號」。設計理由
-- 全部在 §7.2，請一起讀。
--
-- ⚠️ 主鍵是 user_id，不是 (user_id, vendor_id)。這就是 v3「洞二」的修法：v3 的
--    artists.user_id 沒有 UNIQUE，於是 my_artist_id() 只好 `LIMIT 1`，而
--    「你是哪一位藝術家」變成由 heap 掃描順序決定。這裡讓「一個帳號對到兩家
--    廠商」在結構上寫不進去，下游就沒有 LIMIT 1 這種需要。
--
-- ⚠️ 這張表**沒有 role 欄位**。它只回答「是哪一家」，不回答「能做什麼」。
--    v3 的「洞一」（is_admin() 不看 role）就是因為一張表同時被拿來回答兩個問題。
--    廠商能做什麼由 src/lib/admin/middleware.ts 的 vendorFnMiddleware 決定。
create table if not exists public.vendor_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  vendor_id  uuid not null references inv.vendors (id) on delete restrict,
  is_active  boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.vendor_users is
  '廠商自助入口的帳號對照。主鍵是 user_id —— 一個帳號結構上只能對到一家廠商（v3 的 artists.user_id 沒有 UNIQUE，my_artist_id() 只好 LIMIT 1，這裡不重蹈）。刻意沒有 role 欄位：它只回答「是哪一家」。';
comment on column public.vendor_users.vendor_id is
  'on delete restrict —— 廠商還有自助入口帳號時不准刪廠商。與 §6 的四條外鍵同一條規矩：解約要先把帳號收掉，不是讓資料靜默地變成孤兒。';
comment on column public.vendor_users.is_active is
  '停權開關。requireVendor() 每次呼叫都重讀這一欄（與 requireStaff() 重讀 profiles.role 同一條理由：cookie 是身分，權限每次都要重問）。';

create index if not exists vendor_users_vendor_idx on public.vendor_users (vendor_id);

alter table public.vendor_users enable row level security;
revoke all on table public.vendor_users from anon, authenticated;
grant all  on table public.vendor_users to service_role;

-- ---------------------------------------------------------------------------
-- §3  廠商的讀取路徑（全部遮罩過）
-- ---------------------------------------------------------------------------
--
-- ── §3.0  inv_admin_vendors（0016 §5c 的六欄 view）一個字都不動 ───────────
--
-- 4c 交接的第一件事：「inv_admin_vendors 是後台讀廠商的唯一路徑，擴充它的欄位
-- 白名單時，每加一欄都要問這欄該不該讓所有 staff 看到。」
--
-- 這一期的答案是：**不擴充它，一欄都不加。**
--
-- 理由是那個 view 的使用者是誰。它現在被 repos/inv-products.ts 與
-- repos/inv-purchases.ts 用來畫「供應商」下拉選單 —— 商品頁與進貨頁需要的只有
-- 「這家叫什麼、是不是寄賣、還在不在往來」。如果為了廠商後台在它身上加欄位，
-- 那些欄位就會**跟著出現在商品頁與進貨頁的 API response 裡**，而那兩頁沒有任何
-- 理由需要看到廠商的匯款條件或抽成％。
--
-- 「一個 view 服務兩個用途」正是欄位白名單失守的標準劇本：每一次擴充單獨看都
-- 合理，加總起來就變回 select *。所以這裡的做法是**依用途各開一個 view**，每一個
-- 的欄位清單都對自己的頁面負責：
--
--     inv_admin_vendors              6 欄   商品／進貨頁的下拉選單（0016，不動）
--     inv_admin_vendor_list         列表頁  日常經營欄位 + 遮罩後的識別碼
--     inv_admin_vendor_detail       表單頁  四個分頁要編輯的欄位 + 遮罩後的識別碼
--     inv_admin_vendor_contacts     聯絡人
--     inv_admin_vendor_bank_accounts 銀行帳戶（帳號**只有遮罩版**）
--     inv_admin_vendor_attachments  附件清單（只有 metadata，沒有檔案內容）
--
-- ⚠️ 上面沒有一個 view 送得出完整的身分證字號／統編／銀行帳號。那不是疏漏 ——
--    完整值只有 §4 一條路，而那條路一定留痕。

-- ── §3.1  列表 ───────────────────────────────────────────────────────────
--
-- 這個 view 的每一欄都要能回答「列表頁為什麼需要它」：
--   · vendor_code / name / short_name / entity_type  —— 認人
--   · category_name / is_consignment / is_preferred  —— 篩選
--   · status / approval_status                       —— 狀態徽章
--   · phone / email                                  —— 列表上要能直接打電話
--   · tax_id_masked / id_number_masked               —— 對帳時確認「是這一家嗎」
--   · product_count / purchase_count / active_product_count —— 解約前要看得出
--     「刪掉會影響什麼」（§6 的 RESTRICT 會擋，這幾欄讓人在按下去之前就知道）
--   · bank_account_count / attachment_count / contract_expiring
--
-- 沒有進來的：所有原始識別碼、地址、匯款條件細節、備註。那些是表單頁的事。
create or replace view public.inv_admin_vendor_list
with (security_invoker = false) as
select
  v.id                            as vendor_id,
  v.vendor_code                   as vendor_code,
  v.name                          as name,
  v.short_name                    as short_name,
  v.name_en                       as name_en,
  v.entity_type                   as entity_type,
  v.category_id                   as category_id,
  vc.name                         as category_name,
  v.is_consignment                as is_consignment,
  v.is_preferred                  as is_preferred,
  v.status                        as status,
  v.approval_status               as approval_status,
  v.approved_at                   as approved_at,
  approver.name              as approved_by_name,
  v.phone                         as phone,
  v.email                         as email,
  -- ⚠️ 遮罩在這裡，不在前端。完整值不會離開資料庫。
  inv.mask_tail(v.tax_id, 2)      as tax_id_masked,
  inv.mask_tail(v.id_number, 2, 1) as id_number_masked,
  -- 「有沒有填」與「填了什麼」是兩件事。前者不敏感，而且表單要靠它顯示
  -- 「已登錄」還是「未登錄」。
  (nullif(btrim(coalesce(v.tax_id, '')), '') is not null)    as has_tax_id,
  (nullif(btrim(coalesce(v.id_number, '')), '') is not null) as has_id_number,
  (nullif(btrim(coalesce(v.foreign_id, '')), '') is not null
   or nullif(btrim(coalesce(v.residence_permit_number, '')), '') is not null) as has_foreign_id,
  v.commission_rate               as commission_rate,
  v.payment_terms                 as payment_terms,
  v.created_at                    as created_at,
  v.updated_at                    as updated_at,
  coalesce(agg.product_count, 0)        as product_count,
  coalesce(agg.active_product_count, 0) as active_product_count,
  coalesce(agg.stock_units, 0)          as stock_units,
  coalesce(pur.purchase_count, 0)       as purchase_count,
  coalesce(bank.bank_account_count, 0)  as bank_account_count,
  coalesce(att.attachment_count, 0)     as attachment_count,
  att.contract_end_date                 as contract_end_date,
  coalesce(vu.portal_account_count, 0)  as portal_account_count
from inv.vendors v
left join inv.vendor_categories vc on vc.id = v.category_id
left join inv.profiles approver     on approver.user_id = v.approved_by
left join lateral (
  select count(*)::integer                                          as product_count,
         count(*) filter (where p.is_active)::integer               as active_product_count,
         coalesce(sum(p.stock_quantity), 0)::integer                as stock_units
    from inv.products p
   where p.vendor_id = v.id
) agg on true
left join lateral (
  select count(*)::integer as purchase_count
    from inv.purchases pu
   where pu.vendor_id = v.id
) pur on true
left join lateral (
  select count(*)::integer as bank_account_count
    from inv.vendor_bank_accounts b
   where b.vendor_id = v.id
) bank on true
left join lateral (
  select count(*)::integer as attachment_count,
         max(a.contract_end_date) filter (where a.attachment_type = 'contract' and a.is_current)
           as contract_end_date
    from inv.vendor_attachments a
   where a.vendor_id = v.id
) att on true
left join lateral (
  select count(*)::integer as portal_account_count
    from public.vendor_users u
   where u.vendor_id = v.id and u.is_active
) vu on true;

comment on view public.inv_admin_vendor_list is
  '廠商列表。識別碼一律是遮罩版（tax_id_masked／id_number_masked），完整值只有 public.inv_vendor_sensitive() 給得出來而且會留稽核紀錄。只給 service_role。';

-- ── §3.2  單一廠商（表單四個分頁要編輯的欄位）───────────────────────────
--
-- 這裡是全檔案唯一一個接近「48 欄都在」的地方，所以逐欄檢查過一次。進來的是
-- **可編輯的經營欄位**；沒進來的只有五個：tax_id、id_number、foreign_id、
-- residence_permit_number 的原始值（各自有 _masked 對應），以及銀行帳號（在 §3.4）。
create or replace view public.inv_admin_vendor_detail
with (security_invoker = false) as
select
  v.id                              as vendor_id,
  v.vendor_code                     as vendor_code,
  -- 分頁一：基本 + 識別
  v.entity_type                     as entity_type,
  v.category_id                     as category_id,
  v.name                            as name,
  v.name_en                         as name_en,
  v.short_name                      as short_name,
  v.representative                  as representative,
  v.is_preferred                    as is_preferred,
  v.notes                           as notes,
  inv.mask_tail(v.tax_id, 2)                     as tax_id_masked,
  inv.mask_tail(v.id_number, 2, 1)               as id_number_masked,
  inv.mask_tail(v.foreign_id, 2)                 as foreign_id_masked,
  inv.mask_tail(v.residence_permit_number, 2, 1) as residence_permit_number_masked,
  v.foreign_id_type                 as foreign_id_type,
  v.taiwan_residency_status         as taiwan_residency_status,
  v.country_code                    as country_code,
  -- 分頁二：聯絡
  v.phone                           as phone,
  v.fax                             as fax,
  v.email                           as email,
  v.address                         as address,
  v.address_en                      as address_en,
  v.invoice_address                 as invoice_address,
  -- 分頁三：財務 + 寄售抽成
  v.default_tax_type_id             as default_tax_type_id,
  v.default_withholding_category_id as default_withholding_category_id,
  v.is_nhi_applicable               as is_nhi_applicable,
  v.voucher_category                as voucher_category,
  v.einvoice_type                   as einvoice_type,
  v.payment_terms                   as payment_terms,
  v.payment_terms_note              as payment_terms_note,
  v.settlement_type                 as settlement_type,
  v.settlement_start_day            as settlement_start_day,
  v.settlement_interval_days        as settlement_interval_days,
  v.bill_due_day                    as bill_due_day,
  v.is_consignment                  as is_consignment,
  v.cash_fee_rate                   as cash_fee_rate,
  v.domestic_card_fee_rate          as domestic_card_fee_rate,
  v.foreign_card_fee_rate           as foreign_card_fee_rate,
  v.commission_rate                 as commission_rate,
  -- 狀態
  v.status                          as status,
  v.approval_status                 as approval_status,
  v.approved_at                     as approved_at,
  approver.name                as approved_by_name,
  v.created_at                      as created_at,
  v.updated_at                      as updated_at,
  creator.name                 as creator_name
from inv.vendors v
left join inv.profiles approver on approver.user_id = v.approved_by
left join inv.profiles creator  on creator.user_id  = v.created_by;

comment on view public.inv_admin_vendor_detail is
  '單一廠商的可編輯欄位。四個識別碼欄位只有 _masked 版本 —— 完整值走 public.inv_vendor_sensitive()。只給 service_role。';

-- ── §3.3  聯絡人 ─────────────────────────────────────────────────────────
--
-- 聯絡人的姓名／電話／email 是個資，但它是**營業聯絡資訊**，不是身分識別資訊：
-- 店員每天要打電話給窗口，把它擋在 pii.read 後面等於讓日常作業每一次都留一筆
-- 稽核紀錄，紀錄就會被雜訊淹沒到沒有人看。所以它在一般 view 裡，不遮罩。
-- （這個取捨寫在這裡是為了讓下一個人知道它是被想過的，不是漏掉的。）
create or replace view public.inv_admin_vendor_contacts
with (security_invoker = false) as
select
  c.id                 as contact_id,
  c.vendor_id          as vendor_id,
  c.name               as name,
  c.job_title          as job_title,
  c.phone              as phone,
  c.mobile             as mobile,
  c.email              as email,
  c.is_primary         as is_primary,
  c.is_finance_contact as is_finance_contact,
  c.notes              as notes,
  c.sort_order         as sort_order,
  c.created_at         as created_at
from inv.vendor_contacts c;

comment on view public.inv_admin_vendor_contacts is
  '廠商聯絡人。營業聯絡資訊，不遮罩 —— 遮了店員就打不了電話，而每一通電話都留一筆稽核紀錄會讓紀錄失去意義。只給 service_role。';

-- ── §3.4  銀行帳戶 ───────────────────────────────────────────────────────
--
-- ⚠️ account_number **只有遮罩版**。這張 view 沒有任何辦法送出完整帳號。
--    要看完整帳號 → §4，而且會留稽核紀錄。
--    來源系統的寄售對帳報表把完整帳號寫進可下載的 XLSX，那正是這一條在防的事。
create or replace view public.inv_admin_vendor_bank_accounts
with (security_invoker = false) as
select
  b.id                                    as bank_account_id,
  b.vendor_id                             as vendor_id,
  b.account_holder_name                   as account_holder_name,
  b.bank_code                             as bank_code,
  b.bank_name                             as bank_name,
  b.branch_code                           as branch_code,
  b.branch_name                           as branch_name,
  inv.mask_tail(b.account_number, 4)      as account_number_masked,
  b.account_purpose                       as account_purpose,
  b.is_default                            as is_default,
  b.notes                                 as notes,
  b.sort_order                            as sort_order,
  b.created_at                            as created_at
from inv.vendor_bank_accounts b;

comment on view public.inv_admin_vendor_bank_accounts is
  '廠商銀行帳戶。account_number 只有遮罩版（後四碼），完整值走 public.inv_vendor_sensitive()。只給 service_role。';

-- ── §3.5  附件（只有 metadata）──────────────────────────────────────────
--
-- ⚠️ 這裡沒有檔案內容，也沒有可以直接打開的網址。vendor-attachments 是 private
--    bucket；要看檔案得走 server fn 產一張短效 signed URL（見 src/server/storage.ts
--    的 signedVendorAttachmentUrl）。file_path 有進來是因為 server fn 要拿它去簽名，
--    但它本身不是一個能開的東西。
create or replace view public.inv_admin_vendor_attachments
with (security_invoker = false) as
select
  a.id                  as attachment_id,
  a.vendor_id           as vendor_id,
  a.file_name           as file_name,
  a.file_path           as file_path,
  a.file_type           as file_type,
  a.file_size           as file_size,
  a.description         as description,
  a.attachment_type     as attachment_type,
  a.contract_start_date as contract_start_date,
  a.contract_end_date   as contract_end_date,
  a.contract_version    as contract_version,
  a.is_current          as is_current,
  a.uploaded_by         as uploaded_by,
  uploader.name    as uploaded_by_name,
  a.created_at          as created_at
from inv.vendor_attachments a
left join inv.profiles uploader on uploader.user_id = a.uploaded_by;

comment on view public.inv_admin_vendor_attachments is
  '廠商附件與合約的 metadata。沒有檔案內容、沒有永久網址 —— bucket 是 private，要看檔案得走 server fn 簽一張短效 URL。只給 service_role。';

-- ── §3.6  下拉選單用的字典表 ─────────────────────────────────────────────
create or replace view public.inv_admin_vendor_categories
with (security_invoker = false) as
select c.id as category_id, c.name as name, c.description as description,
       c.is_active as is_active, c.sort_order as sort_order
from inv.vendor_categories c;

create or replace view public.inv_admin_tax_types
with (security_invoker = false) as
select t.id as tax_type_id, t.code as code, t.name as name,
       t.rate as rate, t.is_active as is_active, t.sort_order as sort_order
from inv.tax_types t;

create or replace view public.inv_admin_withholding_categories
with (security_invoker = false) as
select w.id as withholding_category_id, w.code as code, w.name as name,
       w.description as description, w.is_active as is_active, w.sort_order as sort_order
from inv.withholding_categories w;

comment on view public.inv_admin_vendor_categories      is '廠商類別字典。只給 service_role。';
comment on view public.inv_admin_tax_types              is '稅別字典。只給 service_role。';
comment on view public.inv_admin_withholding_categories is '扣繳類別字典。只給 service_role。';

-- ⚠️ revoke 才是真正生效的那一半（0013／0016 §6 同一條）。Supabase 對 public
--    schema 有 ALTER DEFAULT PRIVILEGES，新建的 view 一出生就對 anon /
--    authenticated 是 ALL。
revoke all on public.inv_admin_vendor_list             from anon, authenticated;
revoke all on public.inv_admin_vendor_detail           from anon, authenticated;
revoke all on public.inv_admin_vendor_contacts         from anon, authenticated;
revoke all on public.inv_admin_vendor_bank_accounts    from anon, authenticated;
revoke all on public.inv_admin_vendor_attachments      from anon, authenticated;
revoke all on public.inv_admin_vendor_categories       from anon, authenticated;
revoke all on public.inv_admin_tax_types               from anon, authenticated;
revoke all on public.inv_admin_withholding_categories  from anon, authenticated;

grant select on public.inv_admin_vendor_list            to service_role;
grant select on public.inv_admin_vendor_detail          to service_role;
grant select on public.inv_admin_vendor_contacts        to service_role;
grant select on public.inv_admin_vendor_bank_accounts   to service_role;
grant select on public.inv_admin_vendor_attachments     to service_role;
grant select on public.inv_admin_vendor_categories      to service_role;
grant select on public.inv_admin_tax_types              to service_role;
grant select on public.inv_admin_withholding_categories to service_role;

-- ---------------------------------------------------------------------------
-- §3.7  新的細權限：inv.vendor.pii.read
-- ---------------------------------------------------------------------------
--
-- 0010 的 staff_permissions.permission 有一條 CHECK，值域是七種 approve_*。那條
-- CHECK 是刻意的（「打錯字會變成一個永遠不成立的權限，而且不會有人發現」），
-- 所以要多一種權限就得在這裡放寬它 —— 0010 不動，drop 再 add。
--
-- ── 為什麼名字不叫 approve_something ────────────────────────────────────
--
-- 前七種都是「能不能簽核」。這一種是「能不能看」，是另一個維度：一個店員可能
-- 有權簽核進貨（他管收貨），但沒有理由看到廠商的身分證字號。名字用
-- `inv.vendor.pii.read` 的點分格式，就是要讓它在清單裡一眼看得出不同類。
--
-- ── admin 是否自動擁有 ───────────────────────────────────────────────────
--
-- 是，與其餘七種一致（requireStaff() 對 admin 不查表，語意來自來源的
-- `IF is_admin() THEN RETURN true`）。理由不是圖方便：這家店的 admin 就是老闆，
-- 也就是這批個資的持有人，讓他先授權給自己是儀式而不是控制。**真正的控制是
-- §1 的稽核軌跡** —— admin 讀了一樣留紀錄，而且他刪不掉那筆紀錄。
alter table public.staff_permissions drop constraint if exists staff_permissions_permission_check;

alter table public.staff_permissions
  add constraint staff_permissions_permission_check
  check (permission in (
    'approve_products',
    'approve_purchases',
    'approve_price_changes',
    'approve_vendors',
    'approve_combo_sets',
    'approve_stock_adjustments',
    'approve_inventory_adjustments',
    'inv.vendor.pii.read'
  ));

comment on column public.staff_permissions.permission is
  '七種 approve_*（能不能簽核）加上 inv.vendor.pii.read（能不能看到廠商的完整身分證／統編／銀行帳號）。後者是另一個維度：管收貨的店員有理由簽核進貨，沒有理由看身分證。';

-- ---------------------------------------------------------------------------
-- §4  敏感欄位的唯一出口
-- ---------------------------------------------------------------------------
--
-- ── §4.1  為什麼「一定留痕」在這裡是結構保證，不是規定 ────────────────────
--
-- 這一支先 INSERT 稽核紀錄，再組回傳值，兩件事在**同一個交易**裡。於是：
--
--   · 回傳成功 → 交易 commit → 紀錄一定在。
--   · 中途出錯 → 交易 rollback → 紀錄不見了，但**值也沒有送出去**。
--
-- 也就是 log 與 disclosure 同生共死。這正是我們要的語意：稽核軌跡要記錄的是
-- 「有沒有人看到」，不是「有沒有人嘗試看」。（嘗試被擋下來是授權層的事，那一層
-- 有自己的錯誤訊息。）
--
-- 反過來說，如果為了「就算失敗也要留痕」而把 log 拆成 autonomous transaction
-- （PostgreSQL 要靠 dblink 才做得到），就會出現「有紀錄但沒外洩」的假警報，
-- 稽核的人分不出哪一筆是真的。
--
-- ── §4.2  p_fields 是白名單，而且回傳的就是實際給出去的那幾欄 ────────────
--
-- 呼叫端要明講「我要看哪幾欄」，而且只有白名單內的名字會被理會。這讓稽核紀錄
-- 的 fields 欄位有意義：它記的是**實際送出去的欄位**，不是「請求了什麼」。
--
-- ⚠️ 白名單裡沒有 `*`、沒有 `all`。想一次看全部就得把五個名字都列出來，而那筆
--    紀錄就會長成「這個人一次看了五個欄位」—— 那正是稽核要看見的形狀。
create or replace function public.inv_vendor_sensitive(
  p_actor_user_id uuid,
  p_actor_email   text,
  p_vendor_id     uuid,
  p_fields        text[],
  p_reason        text,
  p_access_kind   text default 'staff'
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_vendor   record;
  v_allowed  text[] := array[
    'tax_id', 'id_number', 'foreign_id', 'residence_permit_number', 'bank_accounts'
  ];
  v_wanted   text[];
  v_result   jsonb := '{}'::jsonb;
  v_banks    jsonb;
  v_log_id   uuid;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'VENDOR_PII_NO_ACTOR: 讀取敏感欄位必須記錄操作人員';
  END IF;
  IF p_vendor_id IS NULL THEN
    RAISE EXCEPTION 'VENDOR_PII_NO_TARGET: 沒有指定要看哪一家廠商';
  END IF;

  SELECT id, name, tax_id, id_number, foreign_id, residence_permit_number
    INTO v_vendor
    FROM inv.vendors
   WHERE id = p_vendor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VENDOR_PII_NOT_FOUND: 找不到這家廠商'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 白名單過濾。不在白名單的名字直接消失（不報錯：呼叫端多送一個名字不該讓
  -- 整個查詢失敗，但它也絕對不會拿到那個欄位）。
  SELECT coalesce(array_agg(f ORDER BY f), array[]::text[])
    INTO v_wanted
    FROM unnest(coalesce(p_fields, array[]::text[])) f
   WHERE f = ANY (v_allowed);

  IF array_length(v_wanted, 1) IS NULL THEN
    RAISE EXCEPTION 'VENDOR_PII_NO_FIELDS: 請指定要看哪些欄位'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ⚠️ 先寫紀錄，再組值。順序在同一個交易裡其實不影響結果（見 §4.1），但寫在
  --    前面讓「這一支一定會 log」變成讀第一眼就看得出來的事。
  v_log_id := public.pii_log_access(
    p_actor_user_id,
    p_actor_email,
    'inv.vendors',
    p_vendor_id,
    v_vendor.name,
    v_wanted,
    p_reason,
    coalesce(p_access_kind, 'staff')
  );

  IF 'tax_id' = ANY (v_wanted) THEN
    v_result := v_result || jsonb_build_object('tax_id', v_vendor.tax_id);
  END IF;
  IF 'id_number' = ANY (v_wanted) THEN
    v_result := v_result || jsonb_build_object('id_number', v_vendor.id_number);
  END IF;
  IF 'foreign_id' = ANY (v_wanted) THEN
    v_result := v_result || jsonb_build_object('foreign_id', v_vendor.foreign_id);
  END IF;
  IF 'residence_permit_number' = ANY (v_wanted) THEN
    v_result := v_result || jsonb_build_object(
      'residence_permit_number', v_vendor.residence_permit_number);
  END IF;

  IF 'bank_accounts' = ANY (v_wanted) THEN
    SELECT coalesce(jsonb_agg(
             jsonb_build_object(
               'bank_account_id',     b.id,
               'account_holder_name', b.account_holder_name,
               'bank_code',           b.bank_code,
               'bank_name',           b.bank_name,
               'branch_code',         b.branch_code,
               'branch_name',         b.branch_name,
               'account_number',      b.account_number,
               'account_purpose',     b.account_purpose,
               'is_default',          b.is_default
             ) ORDER BY b.is_default desc, b.sort_order, b.created_at
           ), '[]'::jsonb)
      INTO v_banks
      FROM inv.vendor_bank_accounts b
     WHERE b.vendor_id = p_vendor_id;

    v_result := v_result || jsonb_build_object('bank_accounts', v_banks);

    -- 銀行帳戶是另一張表，再記一筆 subject_table = inv.vendor_bank_accounts 的
    -- 紀錄。這樣「誰看過這家的匯款帳號」查得到，不必去翻 inv.vendors 那一批。
    PERFORM public.pii_log_access(
      p_actor_user_id, p_actor_email, 'inv.vendor_bank_accounts',
      p_vendor_id, v_vendor.name, array['account_number'],
      p_reason, coalesce(p_access_kind, 'staff'));
  END IF;

  RETURN jsonb_build_object(
    'vendor_id', p_vendor_id,
    'log_id',    v_log_id,
    'fields',    to_jsonb(v_wanted),
    'values',    v_result
  );
END;
$$;

comment on function public.inv_vendor_sensitive(uuid, text, uuid, text[], text, text) is
  '廠商敏感欄位的唯一出口。回傳值之前一定先寫一筆 pii_access_log，兩件事在同一個交易 —— 讀成功⇔有紀錄。欄位是白名單，沒有 * 這種寫法。';

revoke execute on function public.inv_vendor_sensitive(uuid, text, uuid, text[], text, text) from public;
revoke execute on function public.inv_vendor_sensitive(uuid, text, uuid, text[], text, text) from anon, authenticated;
grant  execute on function public.inv_vendor_sensitive(uuid, text, uuid, text[], text, text) to service_role;

-- ---------------------------------------------------------------------------
-- §5  廠商的寫入路徑
-- ---------------------------------------------------------------------------
--
-- 與 0016 §4a 的 inv_save_product 同一個形狀：p_payload 的每一個欄位**逐一具名
-- 取出**。payload 裡多送 approval_status、approved_by、created_by、vendor_code
-- 一律被忽略 —— 不是「我們有過濾」，是根本沒有一行程式去讀它們。
--
-- （來源系統的 VendorFormDialog.tsx:266 是
--  `{ ...payload, created_by: user!.id, approval_status: getInitialApprovalStatus('vendors') }`
--  —— 那三樣東西全部由瀏覽器決定，而 DB 沒有任何 trigger 或 CHECK 攔它。）
--
-- ── §5.0  順手補齊的資料完整性 ───────────────────────────────────────────
--
-- 三個「唯一性靠前端兩步 UPDATE 維持」的旗標，改成 partial unique index。來源的
-- 寫法是「先寫這一筆，再發第二個 request 把其他筆設成 false」—— 兩步之間失敗就
-- 留下兩個 is_default = true，而且沒有任何東西會叫。
--
-- 建 index 之前先把既有資料正規化（保留最舊的那一筆），否則 index 建不起來。
update inv.vendor_bank_accounts b
   set is_default = false
 where b.is_default
   and b.id <> (select b2.id from inv.vendor_bank_accounts b2
                 where b2.vendor_id = b.vendor_id and b2.is_default
                 order by b2.sort_order, b2.created_at, b2.id limit 1);

update inv.vendor_contacts c
   set is_primary = false
 where c.is_primary
   and c.id <> (select c2.id from inv.vendor_contacts c2
                 where c2.vendor_id = c.vendor_id and c2.is_primary
                 order by c2.sort_order, c2.created_at, c2.id limit 1);

update inv.vendor_attachments a
   set is_current = false
 where a.is_current and a.attachment_type = 'contract'
   and a.id <> (select a2.id from inv.vendor_attachments a2
                 where a2.vendor_id = a.vendor_id
                   and a2.attachment_type = 'contract' and a2.is_current
                 order by a2.created_at desc, a2.id limit 1);

create unique index if not exists vendor_bank_accounts_one_default_idx
  on inv.vendor_bank_accounts (vendor_id) where is_default;
create unique index if not exists vendor_contacts_one_primary_idx
  on inv.vendor_contacts (vendor_id) where is_primary;
create unique index if not exists vendor_attachments_one_current_contract_idx
  on inv.vendor_attachments (vendor_id) where attachment_type = 'contract' and is_current;

comment on index inv.vendor_bank_accounts_one_default_idx is
  '一家廠商只能有一個預設匯款帳戶。來源靠前端兩次 UPDATE 維持，中間失敗就留下兩個預設帳戶 —— 那會讓匯款打到哪一個帳號變成不確定的事。';

-- ── §5.1  存檔 ───────────────────────────────────────────────────────────
--
-- 驗證搬到資料庫的三組（來源全部只在瀏覽器裡擋，或根本沒擋）：
--
--   a. **識別碼依 entity_type 必填。** 來源 VendorFormDialog.tsx:295-310 有這個
--      判斷，但它在瀏覽器裡 —— 直接 POST 就繞過，然後留下一家「國內公司但沒有
--      統編」的廠商，報稅時才會發現。
--   b. **費率的值域。** 來源前端輸入的是百分比、存檔時 ÷100，而 DB 沒有任何
--      CHECK。所以「手滑少除一次」會存進 8.0（= 800%），而寄賣拆帳直接乘下去。
--   c. **結算日 1–31。** 來源只有 HTML 的 min/max（改一個 request body 就過），
--      DB 沒有 CHECK。settlement_start_day = 45 會讓月結永遠算不出日期。
--
-- ⚠️ approval_status 只在**新增**時由 inv.initial_approval_status('vendors') 決定，
--    編輯時完全不動它。編輯一家已核准的廠商不該讓它掉回待審核（那會讓進貨頁的
--    下拉選單突然少一家）。
create or replace function public.inv_save_vendor(
  p_user_id uuid,
  p_id      uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_id          uuid;
  v_entity      text;
  v_name        text;
  v_tax_id      text;
  v_id_number   text;
  v_foreign_id  text;
  v_permit      text;
  v_created     boolean := false;
  v_code        text;
  v_status      text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NO_OPERATOR: 必須記錄操作人員';
  END IF;

  v_name := nullif(btrim(coalesce(p_payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NO_NAME: 請輸入供應商名稱';
  END IF;

  v_entity := coalesce(nullif(btrim(coalesce(p_payload->>'entity_type', '')), ''), 'domestic_company');
  IF v_entity NOT IN ('domestic_company', 'domestic_individual', 'foreign', 'foreign_individual') THEN
    RAISE EXCEPTION 'VENDOR_BAD_ENTITY_TYPE: 不認得的實體類型「%」', v_entity
      USING ERRCODE = 'check_violation';
  END IF;

  v_tax_id     := nullif(btrim(coalesce(p_payload->>'tax_id', '')), '');
  v_id_number  := upper(nullif(btrim(coalesce(p_payload->>'id_number', '')), ''));
  v_foreign_id := nullif(btrim(coalesce(p_payload->>'foreign_id', '')), '');
  v_permit     := nullif(btrim(coalesce(p_payload->>'residence_permit_number', '')), '');

  -- (a) 識別碼依實體類型必填 —— 在這裡擋，不在瀏覽器擋。
  IF v_entity = 'domestic_company'    AND v_tax_id     IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NEED_TAX_ID: 國內公司必須填統一編號' USING ERRCODE = 'check_violation';
  END IF;
  IF v_entity = 'domestic_individual' AND v_id_number  IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NEED_ID_NUMBER: 國內個人必須填身分證字號' USING ERRCODE = 'check_violation';
  END IF;
  IF v_entity = 'foreign'             AND v_foreign_id IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NEED_FOREIGN_ID: 國外法人必須填國外識別碼' USING ERRCODE = 'check_violation';
  END IF;
  IF v_entity = 'foreign_individual'  AND v_foreign_id IS NULL AND v_permit IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NEED_FOREIGN_OR_PERMIT: 國外個人必須填國外識別碼或居留證號碼'
      USING ERRCODE = 'check_violation';
  END IF;

  -- (b) 費率是 0–1 的小數（畫面上是百分比，換算在前端，但值域在這裡守）。
  PERFORM inv.assert_rate(p_payload->>'cash_fee_rate',          '現金手續費率');
  PERFORM inv.assert_rate(p_payload->>'domestic_card_fee_rate', '國內信用卡手續費率');
  PERFORM inv.assert_rate(p_payload->>'foreign_card_fee_rate',  '國外信用卡手續費率');
  PERFORM inv.assert_rate(p_payload->>'commission_rate',        '抽成比例');

  -- (c) 結算日 1–31。
  PERFORM inv.assert_day_of_month(p_payload->>'settlement_start_day', '結算起算日');
  PERFORM inv.assert_day_of_month(p_payload->>'bill_due_day',         '帳單截止日');

  -- status 是「還有沒有在往來」，與 approval_status 是兩件事。來源的表單根本
  -- 沒有這個欄位的入口（型別有、DB 有、UI 沒有），所以停用廠商實際上做不到。
  v_status := coalesce(nullif(btrim(coalesce(p_payload->>'status', '')), ''), 'active');
  IF v_status NOT IN ('active', 'suspended', 'inactive') THEN
    RAISE EXCEPTION 'VENDOR_BAD_STATUS: 不認得的往來狀態「%」', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO inv.vendors (
      entity_type, category_id, name, name_en, short_name, representative,
      tax_id, id_number, foreign_id, foreign_id_type, residence_permit_number,
      taiwan_residency_status, country_code,
      phone, fax, email, address, address_en, invoice_address,
      default_tax_type_id, default_withholding_category_id, is_nhi_applicable,
      voucher_category, einvoice_type,
      payment_terms, payment_terms_note, settlement_type,
      settlement_start_day, settlement_interval_days, bill_due_day,
      is_consignment, cash_fee_rate, domestic_card_fee_rate, foreign_card_fee_rate,
      commission_rate, is_preferred, notes, status,
      created_by, approval_status
    ) VALUES (
      v_entity,
      (p_payload->>'category_id')::uuid,
      v_name,
      nullif(btrim(coalesce(p_payload->>'name_en', '')), ''),
      nullif(btrim(coalesce(p_payload->>'short_name', '')), ''),
      nullif(btrim(coalesce(p_payload->>'representative', '')), ''),
      v_tax_id, v_id_number, v_foreign_id,
      nullif(btrim(coalesce(p_payload->>'foreign_id_type', '')), ''),
      v_permit,
      nullif(btrim(coalesce(p_payload->>'taiwan_residency_status', '')), ''),
      nullif(btrim(coalesce(p_payload->>'country_code', '')), ''),
      nullif(btrim(coalesce(p_payload->>'phone', '')), ''),
      nullif(btrim(coalesce(p_payload->>'fax', '')), ''),
      nullif(btrim(coalesce(p_payload->>'email', '')), ''),
      nullif(btrim(coalesce(p_payload->>'address', '')), ''),
      nullif(btrim(coalesce(p_payload->>'address_en', '')), ''),
      nullif(btrim(coalesce(p_payload->>'invoice_address', '')), ''),
      (p_payload->>'default_tax_type_id')::uuid,
      (p_payload->>'default_withholding_category_id')::uuid,
      coalesce((p_payload->>'is_nhi_applicable')::boolean, false),
      coalesce(nullif(btrim(coalesce(p_payload->>'voucher_category', '')), ''), 'invoice'),
      coalesce(nullif(btrim(coalesce(p_payload->>'einvoice_type', '')), ''), 'none'),
      coalesce(nullif(btrim(coalesce(p_payload->>'payment_terms', '')), ''), 'immediate'),
      nullif(btrim(coalesce(p_payload->>'payment_terms_note', '')), ''),
      coalesce(nullif(btrim(coalesce(p_payload->>'settlement_type', '')), ''), 'invoice_date'),
      nullif(p_payload->>'settlement_start_day', '')::integer,
      nullif(p_payload->>'settlement_interval_days', '')::integer,
      nullif(p_payload->>'bill_due_day', '')::integer,
      coalesce((p_payload->>'is_consignment')::boolean, false),
      coalesce(nullif(p_payload->>'cash_fee_rate', '')::numeric, 0.08),
      coalesce(nullif(p_payload->>'domestic_card_fee_rate', '')::numeric, 0.101),
      coalesce(nullif(p_payload->>'foreign_card_fee_rate', '')::numeric, 0.1115),
      nullif(p_payload->>'commission_rate', '')::numeric,
      coalesce((p_payload->>'is_preferred')::boolean, false),
      nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      v_status,
      p_user_id,
      inv.initial_approval_status('vendors')   -- ← 不是從 payload 拿
    )
    RETURNING id INTO v_id;
    v_created := true;
  ELSE
    UPDATE inv.vendors SET
      entity_type              = v_entity,
      category_id              = (p_payload->>'category_id')::uuid,
      name                     = v_name,
      name_en                  = nullif(btrim(coalesce(p_payload->>'name_en', '')), ''),
      short_name               = nullif(btrim(coalesce(p_payload->>'short_name', '')), ''),
      representative           = nullif(btrim(coalesce(p_payload->>'representative', '')), ''),
      tax_id                   = v_tax_id,
      id_number                = v_id_number,
      foreign_id               = v_foreign_id,
      foreign_id_type          = nullif(btrim(coalesce(p_payload->>'foreign_id_type', '')), ''),
      residence_permit_number  = v_permit,
      taiwan_residency_status  = nullif(btrim(coalesce(p_payload->>'taiwan_residency_status', '')), ''),
      country_code             = nullif(btrim(coalesce(p_payload->>'country_code', '')), ''),
      phone                    = nullif(btrim(coalesce(p_payload->>'phone', '')), ''),
      fax                      = nullif(btrim(coalesce(p_payload->>'fax', '')), ''),
      email                    = nullif(btrim(coalesce(p_payload->>'email', '')), ''),
      address                  = nullif(btrim(coalesce(p_payload->>'address', '')), ''),
      address_en               = nullif(btrim(coalesce(p_payload->>'address_en', '')), ''),
      invoice_address          = nullif(btrim(coalesce(p_payload->>'invoice_address', '')), ''),
      default_tax_type_id      = (p_payload->>'default_tax_type_id')::uuid,
      default_withholding_category_id = (p_payload->>'default_withholding_category_id')::uuid,
      is_nhi_applicable        = coalesce((p_payload->>'is_nhi_applicable')::boolean, false),
      voucher_category         = coalesce(nullif(btrim(coalesce(p_payload->>'voucher_category', '')), ''), 'invoice'),
      einvoice_type            = coalesce(nullif(btrim(coalesce(p_payload->>'einvoice_type', '')), ''), 'none'),
      payment_terms            = coalesce(nullif(btrim(coalesce(p_payload->>'payment_terms', '')), ''), 'immediate'),
      payment_terms_note       = nullif(btrim(coalesce(p_payload->>'payment_terms_note', '')), ''),
      settlement_type          = coalesce(nullif(btrim(coalesce(p_payload->>'settlement_type', '')), ''), 'invoice_date'),
      settlement_start_day     = nullif(p_payload->>'settlement_start_day', '')::integer,
      settlement_interval_days = nullif(p_payload->>'settlement_interval_days', '')::integer,
      bill_due_day             = nullif(p_payload->>'bill_due_day', '')::integer,
      is_consignment           = coalesce((p_payload->>'is_consignment')::boolean, false),
      cash_fee_rate            = coalesce(nullif(p_payload->>'cash_fee_rate', '')::numeric, 0.08),
      domestic_card_fee_rate   = coalesce(nullif(p_payload->>'domestic_card_fee_rate', '')::numeric, 0.101),
      foreign_card_fee_rate    = coalesce(nullif(p_payload->>'foreign_card_fee_rate', '')::numeric, 0.1115),
      commission_rate          = nullif(p_payload->>'commission_rate', '')::numeric,
      is_preferred             = coalesce((p_payload->>'is_preferred')::boolean, false),
      notes                    = nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      status                   = v_status,
      updated_by               = p_user_id,
      updated_at               = now()
      -- ⚠️ approval_status / approved_by / approved_at 不在這裡。編輯不該改審核狀態。
    WHERE id = p_id
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'VENDOR_NOT_FOUND: 找不到這家廠商' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  SELECT vendor_code, approval_status INTO v_code, v_status FROM inv.vendors WHERE id = v_id;

  RETURN jsonb_build_object(
    'id', v_id, 'created', v_created,
    'vendor_code', v_code, 'approval_status', v_status);
END;
$$;

comment on function public.inv_save_vendor(uuid, uuid, jsonb) is
  '新增／編輯廠商。payload 逐欄具名取出 —— approval_status / created_by / vendor_code 送進來也不會被讀。識別碼依 entity_type 必填、費率 0–1、結算日 1–31 都在這裡守（來源只在瀏覽器擋或根本沒擋）。';

-- 兩支小驗證，抽出來是為了讓上面那支讀得下去。
create or replace function inv.assert_rate(p_value text, p_label text)
returns void
language plpgsql
immutable
as $$
DECLARE v numeric;
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN RETURN; END IF;
  v := p_value::numeric;
  -- 上限 1 = 100%。來源前端輸入百分比、存檔 ÷100，少除一次就會存進 8.0（800%），
  -- 而寄賣拆帳會直接乘下去。
  IF v < 0 OR v > 1 THEN
    RAISE EXCEPTION 'VENDOR_BAD_RATE: %必須是 0 到 1 之間的小數，也就是 0 到 100 百分比（實得 %）',
                    p_label, v
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

create or replace function inv.assert_day_of_month(p_value text, p_label text)
returns void
language plpgsql
immutable
as $$
DECLARE v integer;
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN RETURN; END IF;
  v := p_value::integer;
  IF v < 1 OR v > 31 THEN
    RAISE EXCEPTION 'VENDOR_BAD_DAY: %必須介於 1 與 31（實得 %）', p_label, v
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- ── §5.2  子表：銀行帳戶／聯絡人／附件 ───────────────────────────────────
--
-- 三支的形狀一樣：**先把同一家的旗標清掉，再寫這一筆，同一個交易**。來源是兩次
-- 獨立的 HTTP，中間失敗就留下兩個預設帳戶。§5.0 的 partial unique index 是第二
-- 道門 —— 就算哪天有人寫了第三條路徑，資料庫也不會讓它成立。
create or replace function public.inv_save_vendor_bank_account(
  p_user_id uuid, p_vendor_id uuid, p_id uuid, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_id      uuid;
  v_default boolean := coalesce((p_payload->>'is_default')::boolean, false);
  v_holder  text := nullif(btrim(coalesce(p_payload->>'account_holder_name', '')), '');
  v_number  text := nullif(btrim(coalesce(p_payload->>'account_number', '')), '');
  v_bank    text := nullif(btrim(coalesce(p_payload->>'bank_name', '')), '');
  v_code    text := nullif(btrim(coalesce(p_payload->>'bank_code', '')), '');
BEGIN
  IF p_user_id   IS NULL THEN RAISE EXCEPTION 'VENDOR_NO_OPERATOR: 必須記錄操作人員'; END IF;
  IF p_vendor_id IS NULL THEN RAISE EXCEPTION 'VENDOR_NO_TARGET: 沒有指定廠商'; END IF;
  IF v_holder IS NULL OR v_number IS NULL OR v_bank IS NULL OR v_code IS NULL THEN
    RAISE EXCEPTION 'VENDOR_BANK_INCOMPLETE: 戶名、銀行代碼、銀行名稱、帳號都必須填'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_default THEN
    UPDATE inv.vendor_bank_accounts SET is_default = false
     WHERE vendor_id = p_vendor_id AND is_default AND (p_id IS NULL OR id <> p_id);
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO inv.vendor_bank_accounts (
      vendor_id, account_holder_name, bank_code, bank_name, branch_code, branch_name,
      account_number, account_purpose, is_default, notes, sort_order
    ) VALUES (
      p_vendor_id, v_holder, v_code, v_bank,
      nullif(btrim(coalesce(p_payload->>'branch_code', '')), ''),
      nullif(btrim(coalesce(p_payload->>'branch_name', '')), ''),
      v_number,
      nullif(btrim(coalesce(p_payload->>'account_purpose', '')), ''),
      v_default,
      nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      coalesce((p_payload->>'sort_order')::integer, 0)
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE inv.vendor_bank_accounts SET
      account_holder_name = v_holder,
      bank_code = v_code, bank_name = v_bank,
      branch_code = nullif(btrim(coalesce(p_payload->>'branch_code', '')), ''),
      branch_name = nullif(btrim(coalesce(p_payload->>'branch_name', '')), ''),
      account_number = v_number,
      account_purpose = nullif(btrim(coalesce(p_payload->>'account_purpose', '')), ''),
      is_default = v_default,
      notes = nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      sort_order = coalesce((p_payload->>'sort_order')::integer, 0)
    WHERE id = p_id AND vendor_id = p_vendor_id
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'VENDOR_BANK_NOT_FOUND: 找不到這個匯款帳戶' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'created', p_id IS NULL);
END;
$$;

create or replace function public.inv_save_vendor_contact(
  p_user_id uuid, p_vendor_id uuid, p_id uuid, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_id      uuid;
  v_primary boolean := coalesce((p_payload->>'is_primary')::boolean, false);
  v_name    text := nullif(btrim(coalesce(p_payload->>'name', '')), '');
BEGIN
  IF p_user_id   IS NULL THEN RAISE EXCEPTION 'VENDOR_NO_OPERATOR: 必須記錄操作人員'; END IF;
  IF p_vendor_id IS NULL THEN RAISE EXCEPTION 'VENDOR_NO_TARGET: 沒有指定廠商'; END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'VENDOR_CONTACT_NO_NAME: 請輸入聯絡人姓名' USING ERRCODE = 'check_violation';
  END IF;

  IF v_primary THEN
    UPDATE inv.vendor_contacts SET is_primary = false
     WHERE vendor_id = p_vendor_id AND is_primary AND (p_id IS NULL OR id <> p_id);
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO inv.vendor_contacts (
      vendor_id, name, job_title, phone, mobile, email,
      is_primary, is_finance_contact, notes, sort_order
    ) VALUES (
      p_vendor_id, v_name,
      nullif(btrim(coalesce(p_payload->>'job_title', '')), ''),
      nullif(btrim(coalesce(p_payload->>'phone', '')), ''),
      nullif(btrim(coalesce(p_payload->>'mobile', '')), ''),
      nullif(btrim(coalesce(p_payload->>'email', '')), ''),
      v_primary,
      coalesce((p_payload->>'is_finance_contact')::boolean, false),
      nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      coalesce((p_payload->>'sort_order')::integer, 0)
    ) RETURNING id INTO v_id;
  ELSE
    UPDATE inv.vendor_contacts SET
      name = v_name,
      job_title = nullif(btrim(coalesce(p_payload->>'job_title', '')), ''),
      phone  = nullif(btrim(coalesce(p_payload->>'phone', '')), ''),
      mobile = nullif(btrim(coalesce(p_payload->>'mobile', '')), ''),
      email  = nullif(btrim(coalesce(p_payload->>'email', '')), ''),
      is_primary = v_primary,
      is_finance_contact = coalesce((p_payload->>'is_finance_contact')::boolean, false),
      notes = nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      sort_order = coalesce((p_payload->>'sort_order')::integer, 0)
    WHERE id = p_id AND vendor_id = p_vendor_id
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'VENDOR_CONTACT_NOT_FOUND: 找不到這位聯絡人' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'created', p_id IS NULL);
END;
$$;

-- 附件的 metadata。檔案本身由 src/server/storage.ts 上傳到 private bucket，
-- 這一支只負責把「哪一個檔案屬於哪一家、是不是現行合約」記下來。
create or replace function public.inv_save_vendor_attachment(
  p_user_id uuid, p_vendor_id uuid, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_id      uuid;
  v_type    text := coalesce(nullif(btrim(coalesce(p_payload->>'attachment_type', '')), ''), 'general');
  v_current boolean := coalesce((p_payload->>'is_current')::boolean, false);
BEGIN
  IF p_user_id   IS NULL THEN RAISE EXCEPTION 'VENDOR_NO_OPERATOR: 必須記錄操作人員'; END IF;
  IF p_vendor_id IS NULL THEN RAISE EXCEPTION 'VENDOR_NO_TARGET: 沒有指定廠商'; END IF;
  IF v_type NOT IN ('general', 'contract') THEN
    RAISE EXCEPTION 'VENDOR_BAD_ATTACHMENT_TYPE: 附件類型只能是 general 或 contract'
      USING ERRCODE = 'check_violation';
  END IF;
  IF nullif(btrim(coalesce(p_payload->>'file_path', '')), '') IS NULL THEN
    RAISE EXCEPTION 'VENDOR_ATTACHMENT_NO_PATH: 缺少檔案路徑' USING ERRCODE = 'check_violation';
  END IF;

  IF v_type = 'contract' AND v_current THEN
    UPDATE inv.vendor_attachments SET is_current = false
     WHERE vendor_id = p_vendor_id AND attachment_type = 'contract' AND is_current;
  END IF;

  INSERT INTO inv.vendor_attachments (
    vendor_id, file_name, file_path, file_type, file_size, description,
    uploaded_by, attachment_type, contract_start_date, contract_end_date,
    contract_version, is_current
  ) VALUES (
    p_vendor_id,
    coalesce(nullif(btrim(coalesce(p_payload->>'file_name', '')), ''), '未命名檔案'),
    btrim(p_payload->>'file_path'),
    coalesce(nullif(btrim(coalesce(p_payload->>'file_type', '')), ''), 'application/octet-stream'),
    nullif(p_payload->>'file_size', '')::bigint,
    nullif(btrim(coalesce(p_payload->>'description', '')), ''),
    p_user_id,
    v_type,
    nullif(p_payload->>'contract_start_date', '')::date,
    nullif(p_payload->>'contract_end_date', '')::date,
    nullif(btrim(coalesce(p_payload->>'contract_version', '')), ''),
    v_type = 'contract' AND v_current
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id);
END;
$$;

-- 三支刪除。都要求 vendor_id 對得上 —— 「刪掉一個 id」與「刪掉這家的一個 id」是
-- 兩件事，後者才擋得住「猜一個 uuid 去刪別家的東西」。
create or replace function public.inv_delete_vendor_child(
  p_kind text, p_vendor_id uuid, p_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE v_count integer := 0; v_path text;
BEGIN
  IF p_vendor_id IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NO_TARGET: 沒有指定要刪哪一筆';
  END IF;

  -- 表名是字面識別字，沒有動態 SQL（與 0016 §3 的 inv_approve_record 同一條規矩）。
  CASE p_kind
    WHEN 'bank_account' THEN
      DELETE FROM inv.vendor_bank_accounts WHERE id = p_id AND vendor_id = p_vendor_id;
      GET DIAGNOSTICS v_count = ROW_COUNT;
    WHEN 'contact' THEN
      DELETE FROM inv.vendor_contacts WHERE id = p_id AND vendor_id = p_vendor_id;
      GET DIAGNOSTICS v_count = ROW_COUNT;
    WHEN 'attachment' THEN
      SELECT file_path INTO v_path FROM inv.vendor_attachments
       WHERE id = p_id AND vendor_id = p_vendor_id;
      DELETE FROM inv.vendor_attachments WHERE id = p_id AND vendor_id = p_vendor_id;
      GET DIAGNOSTICS v_count = ROW_COUNT;
    ELSE
      RAISE EXCEPTION 'VENDOR_UNKNOWN_CHILD: 不認得的子項目「%」', p_kind
        USING ERRCODE = 'check_violation';
  END CASE;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'VENDOR_CHILD_NOT_FOUND: 找不到要刪的資料（或它不屬於這家廠商）'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 附件要回傳 file_path，讓呼叫端把 storage 上的檔案一起刪掉。
  RETURN jsonb_build_object('deleted', v_count, 'file_path', v_path);
END;
$$;

-- ── §5.3  刪廠商 = 解約 ──────────────────────────────────────────────────
--
-- 這是 §6 那四條外鍵真正要保護的按鈕。§6 讓資料庫**擋得住**，這一支負責在擋下來
-- 之前先把「為什麼擋」講清楚 —— 一個 23503 的英文錯誤訊息對店員沒有用。
create or replace function public.inv_delete_vendor(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_name     text;
  v_products integer; v_purchases integer; v_returns integer;
  v_portal   integer; v_banks integer; v_attachments integer; v_contacts integer;
BEGIN
  SELECT name INTO v_name FROM inv.vendors WHERE id = p_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND: 找不到這家廠商' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT count(*)::integer INTO v_products  FROM inv.products        WHERE vendor_id = p_id;
  SELECT count(*)::integer INTO v_purchases FROM inv.purchases       WHERE vendor_id = p_id;
  SELECT count(*)::integer INTO v_returns   FROM inv.vendor_returns  WHERE vendor_id = p_id;
  SELECT count(*)::integer INTO v_portal    FROM public.vendor_users WHERE vendor_id = p_id;

  IF v_products > 0 OR v_purchases > 0 OR v_returns > 0 OR v_portal > 0 THEN
    RAISE EXCEPTION
      'VENDOR_IN_USE: 「%」還有 % 件商品、% 筆進貨、% 張退貨單、% 個自助入口帳號，不能直接刪除。解約請把往來狀態改成「已終止」，帳與貨的歷史要留著。',
      v_name, v_products, v_purchases, v_returns, v_portal
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- 沒有往來紀錄才准刪。子表跟著 CASCADE 走（那三張表本來就是廠商的附屬資料）。
  SELECT count(*)::integer INTO v_banks       FROM inv.vendor_bank_accounts WHERE vendor_id = p_id;
  SELECT count(*)::integer INTO v_contacts    FROM inv.vendor_contacts      WHERE vendor_id = p_id;
  SELECT count(*)::integer INTO v_attachments FROM inv.vendor_attachments   WHERE vendor_id = p_id;

  DELETE FROM inv.vendors WHERE id = p_id;

  RETURN jsonb_build_object(
    'id', p_id, 'name', v_name,
    'deleted_bank_accounts', v_banks,
    'deleted_contacts', v_contacts,
    'deleted_attachments', v_attachments);
END;
$$;

comment on function public.inv_delete_vendor(uuid) is
  '刪一家廠商。有商品／進貨／退貨單／自助入口帳號一律擋下，並在訊息裡說明數量與正確做法（改往來狀態，不是刪資料）。';

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.inv_save_vendor(uuid, uuid, jsonb)',
    'public.inv_save_vendor_bank_account(uuid, uuid, uuid, jsonb)',
    'public.inv_save_vendor_contact(uuid, uuid, uuid, jsonb)',
    'public.inv_save_vendor_attachment(uuid, uuid, jsonb)',
    'public.inv_delete_vendor_child(text, uuid, uuid)',
    'public.inv_delete_vendor(uuid)',
    'inv.assert_rate(text, text)',
    'inv.assert_day_of_month(text, text)'
  ] loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon, authenticated', fn);
    execute format('grant  execute on function %s to service_role', fn);
  end loop;
end;
$grants$;

-- ---------------------------------------------------------------------------
-- §6  四條外鍵：從「安靜地弄壞」改成「擋下來並說為什麼」
-- ---------------------------------------------------------------------------
--
-- 4c 交接的第三與第四件事。兩件都是「刪一筆資料，另一個地方靜默壞掉」，而這一期
-- 新增的「廠商解約」按鈕會把它們從偶發變成常態。
--
-- ── §6.1  sales.product_id：SET NULL → RESTRICT（交接第三件）─────────────
--
-- 現況：`ON DELETE SET NULL`。刪一件商品，它的銷售紀錄留著但 product_id 變成
-- NULL —— 那筆營收從此不屬於任何商品，也不屬於任何廠商。正式庫現在有 46 筆
-- product_id IS NULL 的銷售列，其中 45 筆是二手書（0018 §問題三：二手書本來就
-- 沒有 inv.products 那一列，那是對的），**剩下 1 筆是被刪掉的商品留下的孤兒**。
--
-- 為什麼選 RESTRICT 而不是「留著並在報表側處理」：
--
--   · Phase 6 的寄賣結帳要靠 sales → products → vendors 這條鏈算出「這個月要付
--     給哪一家多少錢」。鏈斷掉的那一筆不會報錯，只會**從報表上消失**，而金額對
--     不起來的時候沒有人查得出少的是哪一筆。
--   · 「在報表側處理」的意思是每一張報表都要記得 join 出 NULL 的那幾筆再另外
--     歸類。那是把一個資料完整性問題翻譯成七張報表的七次記得。
--   · 而刪商品這件事本身，在有銷售紀錄之後就不該被允許 —— 賣過的東西不會因為
--     從主檔刪掉就沒賣過。要下架有 is_active，要停售有 status。
--
-- ⚠️ 那 1 筆歷史孤兒**不動**，理由與 0018 對 215 筆歷史套餐銷售一樣：改寫歷史會
--    讓已經結過的帳對不起來。RESTRICT 只約束**未來**的刪除。Phase 6 的報表要把
--    product_id IS NULL AND is_secondhand = false 這一筆單獨列出來，別讓它靜靜地
--    不見。
alter table inv.sales drop constraint if exists sales_product_id_fkey;
alter table inv.sales
  add constraint sales_product_id_fkey
  foreign key (product_id) references inv.products (id) on delete restrict;

comment on constraint sales_product_id_fkey on inv.sales is
  'RESTRICT（0019 §6.1 從 SET NULL 改過來）。賣過的東西不能從主檔消失 —— 那會讓寄賣結帳的 sales→products→vendors 鏈斷掉，而斷掉不會報錯，只會讓那筆營收從報表上消失。';

-- ── §6.2  combo_set_items.product_id：CASCADE → RESTRICT（交接第四件）────
--
-- 現況：`ON DELETE CASCADE`。刪一件商品，它會**從所有套餐裡靜靜地消失**，套餐
-- 本身留著。正式庫的 A1/A2/A3 三個空殼套餐就是這樣來的（combo_sets 6 筆，
-- combo_set_items 只有 6 筆）。
--
-- 空殼套餐比壞掉的套餐更糟：它在櫃檯的套餐清單上看起來正常，賣的時候
-- inv_combo_checkout() 會擋（0018 有擋「沒有組成品項」），但店員只會看到一句
-- 「這個套餐賣不了」，而原因發生在三個月前的另一個頁面上。
--
-- RESTRICT 之後，刪商品時會直接說「它還在某個套餐裡」，人要先去把套餐改掉。
alter table inv.combo_set_items drop constraint if exists combo_set_items_product_id_fkey;
alter table inv.combo_set_items
  add constraint combo_set_items_product_id_fkey
  foreign key (product_id) references inv.products (id) on delete restrict;

comment on constraint combo_set_items_product_id_fkey on inv.combo_set_items is
  'RESTRICT（0019 §6.2 從 CASCADE 改過來）。CASCADE 會讓商品被刪時套餐靜靜變空殼 —— 正式庫的 A1/A2/A3 就是這樣來的，而且要到店員在櫃檯賣不出去才會有人發現。';

-- ── §6.3／§6.4  products.vendor_id 與 purchases.vendor_id：SET NULL → RESTRICT
--
-- 同一種病的上游版本。刪一家廠商，他的商品與進貨批次會留著但 vendor_id 變 NULL
-- —— 於是「這批貨是誰的」在解約當下就永久遺失，而寄賣結帳要的正是那個答案。
--
-- 這兩條是這一期新增的「廠商解約」按鈕最容易踩到的：解約時最直覺的動作就是
-- 「把這家刪掉」，而現況會安靜地讓 14 家廠商的所有進貨批次變成無主。
alter table inv.products drop constraint if exists products_vendor_id_fkey;
alter table inv.products
  add constraint products_vendor_id_fkey
  foreign key (vendor_id) references inv.vendors (id) on delete restrict;

alter table inv.purchases drop constraint if exists purchases_vendor_id_fkey;
alter table inv.purchases
  add constraint purchases_vendor_id_fkey
  foreign key (vendor_id) references inv.vendors (id) on delete restrict;

comment on constraint products_vendor_id_fkey on inv.products is
  'RESTRICT（0019 §6.3 從 SET NULL 改過來）。解約時把廠商刪掉會讓「這批貨是誰的」永久遺失，而那正是寄賣結帳要的答案。';
comment on constraint purchases_vendor_id_fkey on inv.purchases is
  'RESTRICT（0019 §6.4 從 SET NULL 改過來）。理由同 products_vendor_id_fkey。';

-- ── §6.5  inv_delete_product 要跟上 §6.2 ────────────────────────────────
--
-- 0016 的 inv_delete_product() 已經擋掉「有銷售紀錄」與「還連著型錄商品」兩種，
-- 但**沒有擋套餐** —— 因為在 §6.2 之前根本不需要擋：CASCADE 會安靜地把它從套餐裡
-- 拿掉。現在那條外鍵是 RESTRICT，同一個按鈕會丟出一個 23503 的英文錯誤，而店員
-- 看到的會是「update or delete on table products violates foreign key constraint」。
--
-- 所以這裡把那一句話補成中文，並且**把 §6.2 想擋的事講清楚**：不是「不准刪」，
-- 是「先決定那個套餐要怎麼辦」。
--
-- （其餘三個檢查與 0016 逐字相同，一個字都沒有放寬。）
create or replace function public.inv_delete_product(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_name   text;
  v_sales  integer;
  v_links  integer;
  v_combos text;
BEGIN
  SELECT name INTO v_name FROM inv.products WHERE id = p_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: 找不到這件商品' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT count(*) INTO v_sales FROM inv.sales  WHERE product_id = p_id;
  SELECT count(*) INTO v_links FROM public.product_inventory_links WHERE inv_product_id = p_id;

  IF v_sales > 0 THEN
    RAISE EXCEPTION 'PRODUCT_HAS_SALES: 「%」已經有 % 筆銷售紀錄，不能刪除。請改用「停用」。', v_name, v_sales
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_links > 0 THEN
    RAISE EXCEPTION 'PRODUCT_IS_LISTED: 「%」還連著店面型錄商品，請先在「上架」頁下架。', v_name
      USING ERRCODE = 'check_violation';
  END IF;

  -- ← 0019 新增。名字都列出來，因為「哪一個套餐」正是店員接下來要去處理的東西。
  SELECT string_agg(cs.name, '、' ORDER BY cs.name) INTO v_combos
    FROM inv.combo_set_items ci
    JOIN inv.combo_sets cs ON cs.id = ci.combo_set_id
   WHERE ci.product_id = p_id;

  IF v_combos IS NOT NULL THEN
    RAISE EXCEPTION 'PRODUCT_IN_COMBO: 「%」還在套餐「%」裡面，請先把它從套餐移除（或整個套餐停用）。', v_name, v_combos
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM inv.products WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'name', v_name, 'deleted', true);
END;
$$;

comment on function public.inv_delete_product(uuid) is
  '刪一件商品。0019 §6.5 補上套餐檢查 —— combo_set_items 的外鍵在 §6.2 從 CASCADE 改成 RESTRICT 之後，少了這一段店員會看到一句英文的 23503。';

revoke execute on function public.inv_delete_product(uuid) from public;
revoke execute on function public.inv_delete_product(uuid) from anon, authenticated;
grant  execute on function public.inv_delete_product(uuid) to service_role;

-- ⚠️ 刻意**沒有**動的兩條，寫下來免得下一個人以為是漏掉：
--
--   · purchases.product_id 維持 CASCADE。進貨批次是商品的附屬資料（沒有商品就
--     沒有「這批貨」這個概念），而且 §6.1 之後「有銷售紀錄的商品」根本刪不掉，
--     所以會被 CASCADE 掉的只剩「進了貨但一本都沒賣掉就決定不做了」那一種。
--     那一種連同批次一起消失是對的。
--   · products.base_product_id 維持 SET NULL。母品項被刪掉時，子品項退化成一件
--     獨立商品是合理的降級（pack_size 還在，只是不再換算到母品項的庫存）。
--     這裡沒有「金額歸屬遺失」的問題。

-- ---------------------------------------------------------------------------
-- §7  廠商自助入口
-- ---------------------------------------------------------------------------
--
-- ── §7.1  流程 ───────────────────────────────────────────────────────────
--
--   廠商登入 → 送出一件商品 → inv.products (approval_status='pending',
--   submitted_via='vendor_portal') → 店家在後台看到「廠商送審」→ 核准
--   → 可選同時上架（建 public.products + product_inventory_links）
--
-- ── §7.2  vendor_users（表在 §2.5，設計理由在這裡）───────────────────────
--
-- 對照 v3：v3 把「身分」與「權限」混在 admin_users 一張表裡，於是 is_admin() 只好
-- 用「在不在表裡」回答，而 role 欄位形同註解。這裡把兩件事拆開：
--
--     public.profiles.role = 'vendor'   → 能不能登入（0010 就開好的值域）
--     public.vendor_users               → 登入之後是哪一家
--     vendorFnMiddleware                → 能做什麼
--
-- 三個問題三個地方，任何一個寫錯都不會讓另外兩個失效。
--
-- ── §7.3  submitted_via ──────────────────────────────────────────────────
--
-- 店家要看得出「這件是廠商自己送進來的」還是「店員代打的」。兩者的審核標準不同
-- （廠商送的要對照合約，店員送的通常是進貨當下順手建的）。
alter table inv.products
  add column if not exists submitted_via text not null default 'staff';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'products_submitted_via_check' and conrelid = 'inv.products'::regclass
  ) then
    alter table inv.products
      add constraint products_submitted_via_check
      check (submitted_via in ('staff', 'vendor_portal'));
  end if;
end;
$$;

comment on column inv.products.submitted_via is
  'staff=店員在後台建的｜vendor_portal=廠商在自助入口送審的。兩者審核標準不同，而且 vendor_portal 那一種一律 pending（不看 approval_settings）。';

create index if not exists products_vendor_pending_idx
  on inv.products (vendor_id, approval_status) where submitted_via = 'vendor_portal';

-- ── §7.4  「這個帳號是哪一家」—— 唯一的 vendor_id 來源 ───────────────────
--
-- ⚠️ 下面每一支廠商可呼叫的函式都用這一支取得 vendor_id，**沒有任何一支收
--    p_vendor_id 參數**。要偽造成別家廠商，得先偽造 p_user_id，而那個值來自
--    sealed cookie（src/server/vendor-auth.ts），不是 request body。
--
-- ⚠️ 這裡沒有 `LIMIT 1`。vendor_users 的主鍵就是 user_id，一個帳號結構上只會有
--    一列 —— 這正是 v3 洞二的修法。真的查到兩列的話，`strict` 會炸掉而不是隨便
--    挑一列（那就是 v3 的行為）。
create or replace function public.vendor_my_id(p_user_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, inv
as $$
DECLARE v_vendor_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'VENDOR_PORTAL_NO_SESSION: 沒有登入身分'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT u.vendor_id INTO v_vendor_id
    FROM public.vendor_users u
    JOIN inv.vendors v ON v.id = u.vendor_id
   WHERE u.user_id = p_user_id
     AND u.is_active
     AND v.status = 'active'
     AND v.approval_status = 'approved';

  IF v_vendor_id IS NULL THEN
    -- 三種情況（沒綁定／被停權／廠商已終止往來）刻意共用同一句話：讓錯誤訊息
    -- 可以拿來反查「這個 uuid 有沒有綁定」是一個列舉管道。
    RAISE EXCEPTION 'VENDOR_PORTAL_NOT_LINKED: 這個帳號沒有可用的廠商入口權限'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN v_vendor_id;
END;
$$;

comment on function public.vendor_my_id(uuid) is
  '從登入身分取得 vendor_id。這是廠商入口唯一的 vendor_id 來源 —— 其餘每一支函式都不收 p_vendor_id 參數。沒有 LIMIT 1（vendor_users 的主鍵就是 user_id）。';

-- ── §7.5  廠商看自己的資料 ───────────────────────────────────────────────
--
-- ⚠️ 廠商看自己的銀行帳號**一樣要記 pii_access_log**，access_kind='self'。
--    「是自己的資料所以不用記」聽起來合理，但入口的帳號是店家配發的，而配發之後
--    是誰在用是另一件事 —— 帳號被冒用時，那批 self 紀錄是唯一查得出「什麼時候
--    開始不對勁」的東西。
--
-- 這一支回傳的是**遮罩版**。廠商要看自己的完整帳號，走 §7.6，和店員同一條路。
create or replace function public.inv_vendor_profile(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, inv
as $$
DECLARE v_vendor_id uuid; v_row jsonb; v_banks jsonb;
BEGIN
  v_vendor_id := public.vendor_my_id(p_user_id);

  -- ⚠️ 從 detail view 拿，但**拿掉兩個內部欄位**：creator_name 與 approved_by_name
  --    是「哪一位店員建的／核准的」，那是店裡的內部資訊，廠商沒有理由知道。
  --    用 `- 'key'` 而不是重寫一份 select list，是為了讓這裡跟著 detail view 一起
  --    演化 —— 但**新增欄位到 detail view 時要回來想一次「廠商該不該看到」**。
  SELECT to_jsonb(d) - 'creator_name' - 'approved_by_name' INTO v_row
    FROM public.inv_admin_vendor_detail d
   WHERE d.vendor_id = v_vendor_id;

  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.is_default desc, b.sort_order), '[]'::jsonb)
    INTO v_banks
    FROM public.inv_admin_vendor_bank_accounts b
   WHERE b.vendor_id = v_vendor_id;

  RETURN jsonb_build_object('vendor', v_row, 'bank_accounts', v_banks);
END;
$$;

-- ── §7.6  廠商的商品 ─────────────────────────────────────────────────────
--
-- 用 set-returning function 而不是 view，理由只有一個：**view 需要呼叫端自己加
-- WHERE vendor_id = …**，而那個 where 條件會住在 TypeScript 裡。函式讓過濾條件
-- 住在資料庫裡、由 p_user_id 推導，呼叫端就算想寫錯也沒有地方寫。
create or replace function public.inv_vendor_products(p_user_id uuid)
returns table (
  inv_product_id   uuid,
  name             text,
  issue_number     text,
  series           text,
  publisher        text,
  barcode          text,
  notes            text,
  image_key        text,
  product_type     text,
  selling_price    numeric,
  stock_quantity   integer,
  pack_size        integer,
  is_active        boolean,
  approval_status  text,
  approved_at      timestamptz,
  submitted_via    text,
  created_at       timestamptz,
  updated_at       timestamptz,
  sold_quantity    integer,
  listed_slug      text,
  listed_status    text
)
language plpgsql
stable
security definer
set search_path = public, inv
as $$
DECLARE v_vendor_id uuid;
BEGIN
  v_vendor_id := public.vendor_my_id(p_user_id);

  RETURN QUERY
  SELECT p.id, p.name, p.issue_number, p.series, p.publisher, p.barcode, p.notes,
         p.image_key, p.product_type, p.selling_price, p.stock_quantity, p.pack_size,
         p.is_active, p.approval_status, p.approved_at, p.submitted_via,
         p.created_at, p.updated_at,
         coalesce(s.sold, 0)::integer,
         listed.slug, listed.status
    FROM inv.products p
    LEFT JOIN LATERAL (
      SELECT sum(sa.quantity)::integer AS sold
        FROM inv.sales sa WHERE sa.product_id = p.id
    ) s ON true
    LEFT JOIN public.product_inventory_links link ON link.inv_product_id = p.id
    LEFT JOIN public.products listed ON listed.id = link.product_id
   WHERE p.vendor_id = v_vendor_id     -- ← 條件在這裡，不在呼叫端
   ORDER BY p.created_at DESC, p.id;
END;
$$;

-- ── §7.7  送審 ───────────────────────────────────────────────────────────
--
-- ⚠️ approval_status **寫死 'pending'**，不呼叫 inv.initial_approval_status()。
--    見 §0.2：approval_settings 回答的是「我信不信我自己的店員」，跟外部投稿無關。
--    就算哪天有人把 approval_settings.products 關掉，這一條路仍然是待審核。
--
-- ⚠️ vendor_id 由 vendor_my_id() 推導。payload 裡就算有 vendor_id 也不會被讀。
-- ⚠️ stock_quantity 一律 0。廠商說自己有幾本不算數，庫存只能由進貨／盤點改
--    （與 0016 §4a 同一條）。
-- ⚠️ cost_price 不開放廠商填。成本是店家的資訊，不是廠商送出來的欄位。
create or replace function public.inv_vendor_submit_product(
  p_user_id uuid,
  p_id      uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_vendor_id uuid;
  v_id        uuid;
  v_name      text;
  v_price     numeric;
  v_created   boolean := false;
  v_status    text;
BEGIN
  v_vendor_id := public.vendor_my_id(p_user_id);

  v_name := nullif(btrim(coalesce(p_payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'VENDOR_PRODUCT_NO_NAME: 請輸入商品名稱' USING ERRCODE = 'check_violation';
  END IF;

  v_price := coalesce(nullif(p_payload->>'selling_price', '')::numeric, 0);
  IF v_price < 0 THEN
    RAISE EXCEPTION 'VENDOR_PRODUCT_BAD_PRICE: 建議售價不可為負數' USING ERRCODE = 'check_violation';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO inv.products (
      user_id, vendor_id, name, issue_number, series, publisher, barcode,
      notes, image_key, product_type, selling_price, cost_price,
      stock_quantity, pack_size, is_active, approval_status, submitted_via
    ) VALUES (
      p_user_id, v_vendor_id, v_name,
      nullif(btrim(coalesce(p_payload->>'issue_number', '')), ''),
      nullif(btrim(coalesce(p_payload->>'series', '')), ''),
      nullif(btrim(coalesce(p_payload->>'publisher', '')), ''),
      nullif(btrim(coalesce(p_payload->>'barcode', '')), ''),
      nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      nullif(btrim(coalesce(p_payload->>'image_key', '')), ''),
      'consignment',   -- ← 廠商自己送的一律是寄賣，不從 payload 拿
      v_price,
      0,               -- ← 成本不開放廠商填
      0,               -- ← 庫存一律 0，靠進貨加上去
      1,
      false,           -- ← 還沒核准就不該是上架狀態
      'pending',       -- ← 寫死。不呼叫 initial_approval_status()，見 §0.2
      'vendor_portal'
    )
    RETURNING id INTO v_id;
    v_created := true;
  ELSE
    -- 只能改自己的、而且只能改還在待審核的那幾件。已核准的商品由店家維護。
    UPDATE inv.products SET
      name          = v_name,
      issue_number  = nullif(btrim(coalesce(p_payload->>'issue_number', '')), ''),
      series        = nullif(btrim(coalesce(p_payload->>'series', '')), ''),
      publisher     = nullif(btrim(coalesce(p_payload->>'publisher', '')), ''),
      barcode       = nullif(btrim(coalesce(p_payload->>'barcode', '')), ''),
      notes         = nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      image_key     = nullif(btrim(coalesce(p_payload->>'image_key', '')), ''),
      selling_price = v_price,
      updated_at    = now()
    WHERE id = p_id
      AND vendor_id = v_vendor_id                -- ← 別家的 id 在這裡就打不中
      AND submitted_via = 'vendor_portal'
      AND approval_status = 'pending'
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RAISE EXCEPTION 'VENDOR_PRODUCT_NOT_EDITABLE: 找不到這件待審核商品，或它已經被處理過了'
        USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  SELECT approval_status INTO v_status FROM inv.products WHERE id = v_id;
  RETURN jsonb_build_object('id', v_id, 'created', v_created, 'approval_status', v_status);
END;
$$;

comment on function public.inv_vendor_submit_product(uuid, uuid, jsonb) is
  '廠商送審一件商品。沒有 p_vendor_id 參數（由 vendor_my_id() 推導），approval_status 寫死 pending（不看 approval_settings，見 §0.2），庫存與成本都不開放廠商填。';

-- 撤回：只能撤自己的、還在待審核的。
create or replace function public.inv_vendor_withdraw_product(p_user_id uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE v_vendor_id uuid; v_name text; v_count integer;
BEGIN
  v_vendor_id := public.vendor_my_id(p_user_id);

  SELECT name INTO v_name FROM inv.products
   WHERE id = p_id AND vendor_id = v_vendor_id
     AND submitted_via = 'vendor_portal' AND approval_status = 'pending';

  DELETE FROM inv.products
   WHERE id = p_id AND vendor_id = v_vendor_id
     AND submitted_via = 'vendor_portal' AND approval_status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'VENDOR_PRODUCT_NOT_WITHDRAWABLE: 找不到這件待審核商品，或它已經被處理過了'
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN jsonb_build_object('id', p_id, 'name', v_name);
END;
$$;

-- 後台的「廠商送審」佇列。
--
-- 為什麼另開一個 view 而不是把 submitted_via 加進 0016 的 inv_admin_products：
-- `create or replace view` 只能在**尾端**加欄位，要在中間加就得把 0016 那五十行
-- select list 原樣抄一份過來 —— 而那份抄本會與 0016 各自演化，變成兩個定義。
-- 這個 view 只有待審佇列在用，欄位也只有那一頁需要的，各自負責比較乾淨。
create or replace view public.inv_admin_vendor_submissions
with (security_invoker = false) as
select
  p.id              as inv_product_id,
  p.name            as name,
  p.issue_number    as issue_number,
  p.series          as series,
  p.publisher       as publisher,
  p.barcode         as barcode,
  p.notes           as notes,
  p.image_key       as image_key,
  p.selling_price   as selling_price,
  p.approval_status as approval_status,
  p.submitted_via   as submitted_via,
  p.created_at      as created_at,
  p.updated_at      as updated_at,
  v.id              as vendor_id,
  v.name            as vendor_name,
  v.vendor_code     as vendor_code,
  v.is_consignment  as vendor_is_consignment,
  v.commission_rate as vendor_commission_rate
from inv.products p
left join inv.vendors v on v.id = p.vendor_id
where p.submitted_via = 'vendor_portal';

comment on view public.inv_admin_vendor_submissions is
  '廠商從自助入口送進來的商品（含已核准的，狀態靠 approval_status 篩）。只帶廠商的名稱、編號與抽成％ —— 審核這一頁沒有理由需要看到統編或匯款帳戶。只給 service_role。';

revoke all    on public.inv_admin_vendor_submissions from anon, authenticated;
grant  select on public.inv_admin_vendor_submissions to service_role;

-- ── §7.8  核准（+ 可選同時上架）─────────────────────────────────────────
--
-- 審核本身走 0016 的 inv_approve_record('products')，一個字都沒有另外寫 —— 那支
-- 已經守住「只受理 pending → approved/rejected」。
--
-- 「同時上架」在**同一個交易**裡建 public.products 與 product_inventory_links。
-- 這順手修掉 repos/inventory-listing.ts#createInventoryListing 的形狀：那裡是兩個
-- 獨立的 insert，第二個失敗時靠 TypeScript 手動 delete 回捲 —— 而那個 delete 自己
-- 也可能失敗，留下一件「庫存永遠算不出來」的型錄商品。
--
-- ⚠️ 上架需要三語文案，而廠商給不出來（0011 §「兩邊的資料形狀不一樣」）。所以
--    p_listing 是**店員在核准對話框裡填的**，不是廠商送上來的。廠商送的 payload
--    到不了這裡。
create or replace function public.inv_approve_vendor_product(
  p_user_id  uuid,
  p_id       uuid,
  p_approved boolean,
  p_listing  jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_approval   jsonb;
  v_product_id text;
  v_slug       text;
  v_units      integer;
BEGIN
  v_approval := public.inv_approve_record(p_user_id, 'products', p_id, p_approved);

  IF NOT p_approved OR p_listing IS NULL OR NOT coalesce((v_approval->>'changed')::boolean, false) THEN
    RETURN v_approval || jsonb_build_object('listed', false);
  END IF;

  v_slug := nullif(btrim(coalesce(p_listing->>'slug', '')), '');
  IF v_slug IS NULL THEN
    RAISE EXCEPTION 'LISTING_NO_SLUG: 上架必須有網址代稱' USING ERRCODE = 'check_violation';
  END IF;

  v_units := greatest(coalesce((p_listing->>'units_per_sale')::integer, 1), 1);
  v_product_id := gen_random_uuid()::text;

  INSERT INTO public.products (
    id, slug, product_type, title, summary, description,
    price, stock, capacity, image_key, requires_shipping, status, sort_order
  ) VALUES (
    v_product_id, v_slug,
    coalesce(nullif(btrim(coalesce(p_listing->>'product_type', '')), ''), 'goods'),
    p_listing->'title', p_listing->'summary', p_listing->'description',
    (p_listing->>'price')::integer,
    null,   -- ← 庫存由 product_inventory_links 導出，不在型錄這一側存（0011）
    null,
    nullif(btrim(coalesce(p_listing->>'image_key', '')), ''),
    true,
    coalesce(nullif(btrim(coalesce(p_listing->>'status', '')), ''), 'draft'),
    0
  );

  INSERT INTO public.product_inventory_links (product_id, inv_product_id, units_per_sale)
  VALUES (v_product_id, p_id, v_units);

  RETURN v_approval || jsonb_build_object(
    'listed', true, 'product_id', v_product_id, 'slug', v_slug);
END;
$$;

comment on function public.inv_approve_vendor_product(uuid, uuid, boolean, jsonb) is
  '核准廠商送審的商品，可選同時上架。審核走 0016 的 inv_approve_record；上架的兩個 insert 在同一個交易裡（repos/inventory-listing.ts 是兩個獨立 insert 加手動回捲）。三語文案由店員填，廠商送不進來。';

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.vendor_my_id(uuid)',
    'public.inv_vendor_profile(uuid)',
    'public.inv_vendor_products(uuid)',
    'public.inv_vendor_submit_product(uuid, uuid, jsonb)',
    'public.inv_vendor_withdraw_product(uuid, uuid)',
    'public.inv_approve_vendor_product(uuid, uuid, boolean, jsonb)'
  ] loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon, authenticated', fn);
    execute format('grant  execute on function %s to service_role', fn);
  end loop;
end;
$grants$;

-- ---------------------------------------------------------------------------
-- §8  v3 的 artists 併進來
-- ---------------------------------------------------------------------------
--
-- ── §8.1  v3 的 artists 是什麼、缺什麼 ───────────────────────────────────
--
-- 舊網站 v3 的 artists 就是寄售廠商，但只有形象那一半：有 bio、頭像、個人網站，
-- 沒有聯絡方式、沒有統編匯款帳戶、沒有庫存、沒有對帳。而 artist_products.price
-- 是 **TEXT**（存的是 `"NT$ 2,800"` 這種含幣別與逗號的自由文字）—— 無法排序、
-- 無法加總、無法接金流。
--
-- 已決定的做法：
--   · inv.vendors           = 會計面主檔（統編、匯款、抽成、對帳）
--   · public.artists        = **前台展示表**，加一個可為 NULL 的 vendor_id
--   · artist_products       = **廢除**。商品由 inv.products（庫存與成本）
--                             + public.products（三語文案與定價）
--                             + product_inventory_links（把兩者綁起來）三張表分擔
--
-- vendor_id 可為 NULL 是刻意的：有些藝術家只是介紹（策展過、合作過），店裡沒有
-- 賣他的東西，也就沒有會計面的對應。硬要每一位藝術家都建一家廠商，只會在
-- inv.vendors 裡長出一批沒有統編、沒有匯款帳戶、永遠不會出現在對帳單上的空殼。
--
-- ── §8.2  v3 的三個權限漏洞，在這個模型裡各自為什麼不存在 ────────────────
--
--   洞一（is_admin() 不看 role）→ public.artists 是 RLS 開著、寫入零 policy、
--        anon/authenticated 只有 SELECT 且限 is_active。寫入只有 service_role
--        經 server fn，而 server fn 掛 adminFnMiddleware。「policy 判斷寫錯」
--        沒有作用對象。
--
--   洞二（user_id 無 UNIQUE + LIMIT 1）→ **public.artists 根本沒有 user_id 這一欄。**
--        身分對照在 public.vendor_users（主鍵 user_id）。artists 只是展示資料，
--        不參與任何授權判斷。另外對 vendor_id 加 UNIQUE，讓「這家廠商的藝術家頁
--        是哪一頁」也不會變成 LIMIT 1 的問題。
--
--   洞三（`admin_all` 這條 `FOR ALL USING (is_admin())` 的 PERMISSIVE policy 蓋過
--        所有 owner-scoped policy，因為 PostgreSQL 的 PERMISSIVE policy 是 OR 合併）
--        → 這裡對 anon/authenticated 只有一條 SELECT policy 加三條 RESTRICTIVE
--        的 deny（與 0015 的 publications 同一個形狀）。RESTRICTIVE 是 AND 合併，
--        所以再多一條 PERMISSIVE 也打不開寫入。
--
-- ⚠️ v3 的 migration 裡有一支把某位真實使用者的密碼用明文寫死在 SQL 檔裡
--    （`UPDATE auth.users SET encrypted_password = crypt('<明文>')`）。那個帳號的
--    密碼要當成已外洩處理。v3 整個資料夾在 .gitignore 裡，一行都不會進版控。
create table if not exists public.artists (
  id           text primary key,
  slug         text not null unique,
  name         text not null,
  name_en      text,
  discipline   text,
  bio          text,
  long_bio     text,
  image_key    text,
  portal_url   text,

  -- 會計面的那一半。可為 NULL：有些藝術家只是介紹，店裡沒有賣他的東西。
  vendor_id    uuid unique references inv.vendors (id) on delete set null,

  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.artists is
  '前台的藝術家介紹（v3 的 artists 併進來）。只有形象資料 —— 統編、匯款、抽成、對帳全部在 inv.vendors，兩者用 vendor_id 對起來。v3 的 artist_products 已廢除，商品走 inv.products + public.products + product_inventory_links。';
comment on column public.artists.vendor_id is
  'UNIQUE 且可為 NULL。UNIQUE 是 v3「user_id 沒有 UNIQUE 導致 my_artist_id() 只好 LIMIT 1」那個洞的修法；可為 NULL 是因為有些藝術家只是介紹，沒有會計面的對應。';
comment on column public.artists.image_key is
  'v3 是 image_url（外部網址）。這裡沿用本站的 image_key 慣例（bundled key 或 storage:…），與 public.products / inv.products 同一種值。';

create index if not exists artists_active_idx on public.artists (is_active, sort_order);

alter table public.artists enable row level security;

-- ⚠️ revoke 先於 grant（0013／0015 §同一條）：Supabase 的 ALTER DEFAULT PRIVILEGES
--    讓新表一出生就對 anon/authenticated 是 ALL。
revoke all    on table public.artists from anon, authenticated;
grant  select on table public.artists to anon, authenticated;
grant  all    on table public.artists to service_role;

drop policy if exists artists_select_public on public.artists;
create policy artists_select_public on public.artists
  as permissive for select to anon, authenticated
  using (is_active);

-- 三條 RESTRICTIVE 的 deny。RESTRICTIVE 是 AND 合併，所以就算日後有人手滑加了
-- 一條 PERMISSIVE 的寫入 policy，也打不開 —— 這正是 v3 洞三缺的那一半。
drop policy if exists artists_deny_insert on public.artists;
create policy artists_deny_insert on public.artists
  as restrictive for insert to anon, authenticated with check (false);

drop policy if exists artists_deny_update on public.artists;
create policy artists_deny_update on public.artists
  as restrictive for update to anon, authenticated using (false) with check (false);

drop policy if exists artists_deny_delete on public.artists;
create policy artists_deny_delete on public.artists
  as restrictive for delete to anon, authenticated using (false);

-- 後台編輯用的 view（含未上架的，以及會計面那一側的名字）。
create or replace view public.inv_admin_artists
with (security_invoker = false) as
select
  a.id          as artist_id,
  a.slug        as slug,
  a.name        as name,
  a.name_en     as name_en,
  a.discipline  as discipline,
  a.bio         as bio,
  a.long_bio    as long_bio,
  a.image_key   as image_key,
  a.portal_url  as portal_url,
  a.vendor_id   as vendor_id,
  v.name        as vendor_name,
  v.vendor_code as vendor_code,
  v.is_consignment as vendor_is_consignment,
  a.sort_order  as sort_order,
  a.is_active   as is_active,
  a.created_at  as created_at,
  a.updated_at  as updated_at
from public.artists a
left join inv.vendors v on v.id = a.vendor_id;

comment on view public.inv_admin_artists is
  '後台的藝術家清單（含未上架）。只帶廠商的名稱與編號 —— 這一頁沒有任何理由需要看到統編或匯款帳戶。只給 service_role。';

revoke all    on public.inv_admin_artists from anon, authenticated;
grant  select on public.inv_admin_artists to service_role;

-- ---------------------------------------------------------------------------
-- §9  兩個 private bucket 的保留期限（交接第五件）
-- ---------------------------------------------------------------------------
--
-- ── §9.1  vendor-attachments ─────────────────────────────────────────────
--
-- 這個 bucket 在來源系統就已經是 private（20 MiB），是來源少數做對的地方之一。
-- 這裡把它原樣記錄進版控（0003 的 site-images 也是這樣做的：「這一句已經在正式
-- 專案上跑過了，但這個 repo 是 source of truth，所以照樣寫下來」），並且**補上
-- allowed_mime_types** —— 來源只在瀏覽器擋副檔名，storage 端什麼都收。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'vendor-attachments',
  'vendor-attachments',
  false,     -- ← 合約上有身分證影本與匯款帳戶
  20971520,  -- 20 MiB，與來源一致
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 零 storage.objects policy（與 ocr-scans、site-images 一致）：只有 service_role
-- 讀得到、寫得到。前端拿到的是短效 signed URL，不是永久網址。
--
-- ⚠️ 來源系統的 storage policy 是 `bucket_id = 'vendor-attachments' AND is_approved()`
--    —— 任何一個通過註冊審核的店員都讀得到所有廠商的合約掃描檔，而且路徑第一段
--    雖然是 vendor_id，policy 完全沒有拿它做 scoping。那套 policy 一條都沒有搬。

-- ── §9.2  保留期限 ───────────────────────────────────────────────────────
--
-- 4c 交接的第五件事：ocr-scans 刻意保留原圖（辨識可疑時要調得出來對照），但進貨
-- 單上有廠商名稱與單價，屬於這一期的 PII 治理範圍，而目前**沒有任何自動清理**。
--
-- 政策（寫在這裡，跑在 src/server/task-endpoints.ts 的排程）：
--
--     ocr-scans           保留 180 天。理由：辨識結果的爭議通常在當月對帳時就會
--                         浮現，一季是寬鬆的上限，半年是「連年度結算都過了」。
--     vendor-attachments  **不自動清理。** 合約是契約文件，保留義務由稅法與契約
--                         本身決定（商業會計法是 5 年、憑證 5 年），不該由一支
--                         排程猜。這裡只提供「列出過期合約」讓人決定。
--
-- ⚠️ 這一支只算出「哪些該清」，**不自己刪 storage 物件** —— storage 的刪除只能
--    從 API 端做（PostgreSQL 端刪 storage.objects 那一列會留下孤兒檔案）。所以
--    它回傳清單，由 task endpoint 呼叫 Storage API 刪完再回報。
create or replace function public.ocr_scan_retention_days()
returns integer
language sql
immutable
as $$ select 180; $$;

comment on function public.ocr_scan_retention_days() is
  'ocr-scans 的保留天數。抽成函式而不是寫死在程式裡，是為了讓「保留多久」這個政策決定有一個查得到的位置。';

revoke execute on function public.ocr_scan_retention_days() from public;
revoke execute on function public.ocr_scan_retention_days() from anon, authenticated;
grant  execute on function public.ocr_scan_retention_days() to service_role;

-- ---------------------------------------------------------------------------
-- §10  收尾：inv 對 anon / authenticated 仍然是零 grant
-- ---------------------------------------------------------------------------
--
-- 0009 §0 的第二條規矩。這個檔案新增了 5 支 inv.* 函式（mask_tail、assert_rate、
-- assert_day_of_month）與一批 public 的 view／函式，每一個都在自己的段落裡
-- revoke 過了。這裡再掃一次整個 schema，理由與 0016 §6 相同：Supabase 的
-- ALTER DEFAULT PRIVILEGES 只要有人用 dashboard 建了一個物件就會破功，而破功是
-- 靜默的。
revoke all on schema inv from anon, authenticated;
revoke all on all tables    in schema inv from anon, authenticated;
revoke all on all functions in schema inv from anon, authenticated;
revoke all on all sequences in schema inv from anon, authenticated;

commit;
