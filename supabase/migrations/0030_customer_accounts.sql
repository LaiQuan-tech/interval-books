-- 0030_customer_accounts.sql —— 客人帳號：把「訪客下的單」認領給註冊後的帳號
--
-- 前一支是 0029_event_seats_visibility.sql。既有 0001–0029 一律不動（規約：已套用的
-- migration 永不修改），所以要加的東西都用這一支新的來加。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 這一支在補什麼
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 客人下單之後沒有地方可以回來查。訂單完成頁只靠網址上的 public_token（0005:67
-- 那一欄的註解寫著「Unguessable order lookup key for guests」），關掉分頁就找不
-- 回來了 —— 而那張單裡有他的姓名、電話、地址。
--
-- `public.orders.user_id` 這一欄從 0005 就在（0005:65，uuid、nullable、FK 指向
-- auth.users），但**從來沒有被寫過**：createOrder() 的 insert 一個字都沒提它，
-- 正式庫上 0 筆有值。這一支不新增那一欄，它只做一件事：把「已經存在、但沒有主人」
-- 的訂單，在客人註冊並驗證信箱之後，指給那個帳號。
--
-- ── 這一支不做的事 ────────────────────────────────────────────────────────
--
--   · 不開 RLS policy、不對 anon／authenticated 加任何 grant。0005:318-336 那段
--     的姿態原樣保留：orders 家族 RLS 開著、零 policy、零 grant，只有 service_role
--     進得去。授權在 server function（src/server/customer-auth.ts +
--     src/server/repos/customer-orders.ts），不在資料庫的 policy 層。
--     瀏覽器在這個 repo 裡從來沒有拿過 Supabase JWT（見 src/server/session.ts 檔頭），
--     所以就算加了 policy 也沒有任何東西會去滿足它 —— 那只會變成一段沒人執行、
--     卻讓下一個人以為「資料庫會擋」的死程式碼。
--
--   · 不動 order_items。品項的快照（name / unit_price / subtotal / product_type /
--     session_id）0005 與 0020 已經存好了，客人的訂單頁不需要 join products。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- claim_guest_orders(p_user_id) —— 三道閘，一道都不能少
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 這支函式的輸入只有一個 user_id。**它不收 email 參數**，這是整支函式最重要的
-- 一個決定：收了 email 就等於「誰能呼叫這支、誰就能認領任意信箱的訂單」，那時
-- 這支 security definer 函式會變成一個把全站個資按信箱發放的介面。email 一定
-- 從 auth.users 讀，由 p_user_id 決定是誰。
--
-- 三道閘寫在 SQL 裡，每一道旁邊都記著「少了它會發生什麼事」。它們不是三種寫法
-- 的同一件事，是三種不同的攻擊：
--
--   ① auth.users.email_confirmed_at is not null
--        少了它：攻擊者拿受害者的 email 去註冊、**不點驗證信**，就直接認領對方
--        所有的訂單（姓名、電話、地址、買了什麼）。註冊是任何人都能做的動作，
--        所以少了這一道，整套帳號機制等於把個資按信箱公開發放。
--        這一道是三道裡唯一擋得住「主動攻擊」的，其餘兩道擋的是資料錯亂。
--
--   ② auth.users.deleted_at is null
--        少了它：被停用／刪除的帳號（Supabase 的刪除是軟刪除，那一列還在）仍然
--        能認領訂單。帳號被關掉的理由通常正是「這個人不該再看到這些東西」。
--
--   ③ public.orders.user_id is null
--        少了它：一張已經有主人的訂單會被重新指給別人。email 是可以換的
--        （Supabase Auth 允許改 email），所以「兩個 user 先後擁有同一個 email
--        字串」是做得到的 —— 少了這一道，後來的那一個人會把前一個人的訂單整批
--        搶走。有了它，這支函式對已認領的訂單永遠是 no-op，也因此可以安全地在
--        每次登入時無條件呼叫。
--
-- ⚠️ 這三道不要「順手優化」掉。①②看起來像是「反正登入流程已經擋過了」——
--    不是的：擋在應用層的那一道跟這一道守的不是同一個東西。這支函式是
--    security definer，它的正確性不能建立在「呼叫它的人已經檢查過了」之上。
--
-- ── 比對方式：lower(trim(...)) 兩邊都做 ──────────────────────────────────
-- 訂單的 customer_email 是客人在結帳表單自己打的，前後空白與大小寫都可能與註冊
-- 時打的不一樣。兩邊都套同一個正規化，並且用同一個表達式建索引（見檔尾），這樣
-- 這個 update 走的是 index scan 而不是全表掃描。
--
-- ── security definer + set search_path = '' ──────────────────────────────
-- 這個 repo 既有的函式寫的是 `set search_path = public`。這一支收得更緊：空字串
-- 代表**沒有任何 schema 在搜尋路徑上**，所以函式體裡每一個物件都必須寫全名
-- （public.orders / auth.users）。少寫一個 schema 就會在套用當下當場報錯，而不是
-- 在某個把 public 換掉的 session 裡被接管。pg_catalog 永遠隱含在搜尋路徑裡，
-- 所以 lower/trim/now 這些內建函式不受影響。

begin;

-- ---------------------------------------------------------------------------
-- 0. 前置檢查：這一支依賴 auth.users 的兩個欄位
-- ---------------------------------------------------------------------------
-- auth schema 是 Supabase（GoTrue）管的，不在這個 repo 的 migration 裡。兩個閘門
-- 用到的欄位若哪天不在了，底下 `create function` 只會丟一句 "column u.deleted_at
-- does not exist"，而那句話不會告訴讀的人「你剛剛失去的是哪一道防線」。
-- 先在這裡吵一次，把失敗變成看得懂的失敗。
do $$
declare missing text[];
begin
  select coalesce(array_agg(c), array[]::text[]) into missing
    from unnest(array['email_confirmed_at', 'deleted_at']) as c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'auth' and table_name = 'users' and column_name = c
   );

  if array_length(missing, 1) is not null then
    raise exception
      'auth.users 少了這幾個欄位：%。claim_guest_orders 的三道閘有兩道建立在它們上面（未驗證信箱、已刪除帳號），少了任何一個就不要套用這一支 —— 先確認 GoTrue 版本，不要把閘門拿掉。',
      array_to_string(missing, ', ');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. claim_guest_orders(uuid)
-- ---------------------------------------------------------------------------
create or replace function public.claim_guest_orders(p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_n     int;
begin
  if p_user_id is null then return 0; end if;

  -- ⚠️ email 一定從 auth.users 讀，**永遠不要收 email 當參數**：收了就等於誰能
  --    呼叫這支、誰就能認領任意信箱的訂單。
  --
  -- 閘門 ①：email_confirmed_at is not null
  --   少了它 → 攻擊者用受害者的 email 註冊但不點驗證信，就能認領對方的訂單。
  -- 閘門 ②：deleted_at is null
  --   少了它 → 已被刪除（軟刪除，列還在）的帳號仍然認領得到訂單。
  select lower(trim(u.email)) into v_email
    from auth.users u
   where u.id = p_user_id
     and u.email_confirmed_at is not null
     and u.deleted_at is null;

  -- 查不到（不存在／未驗證／已刪除）就是 0 筆，不是錯誤：呼叫端每次登入都會打
  -- 這一支，未驗證的帳號在這裡安靜地拿到 0 是對的行為。
  if v_email is null or v_email = '' then return 0; end if;

  update public.orders
     set user_id    = p_user_id,
         -- 0005:304-315 的 set_updated_at trigger 本來就會設它。這裡明寫是為了
         -- 讓「這一列被誰、在什麼時候認領」在 SQL 上讀得出來，不必去追 trigger。
         updated_at = now()
   -- 閘門 ③：只認領還沒有主人的訂單。
   --   少了它 → 一張已經屬於別人的訂單會被重新指過來（email 是可以換的）。
   --   有了它 → 這支函式對已認領的訂單是 no-op，因此可以每次登入無條件呼叫。
   where user_id is null
     -- 0005:77 的 customer_email 目前是 NOT NULL。這一條是防守：哪天有人把
     -- NOT NULL 拿掉，null 進到底下的比較會變成「誰都對不上」（安全的方向），
     -- 但寫明白比依賴三值邏輯的巧合好。
     and customer_email is not null
     and lower(trim(customer_email)) = v_email;

  get diagnostics v_n = row_count;
  return v_n;
end
$$;

comment on function public.claim_guest_orders(uuid) is
  '把 customer_email 對得上、而且還沒有主人的訪客訂單，指給這個 user。三道閘：信箱已驗證、帳號未刪除、訂單未被認領 —— 少任何一道都會變成個資外洩管道，見 0030 檔頭。**不收 email 參數**是刻意的。';

-- create or replace 會保留既有權限，這幾句是防守（與 0028 對 invoice_backlog
-- 做的是同一件事）：萬一有人在別的地方 drop 過再建，套完之後權限一定還是對的。
--
-- ⚠️ authenticated 也在 revoke 清單裡，而且**必須**在。這支函式是 security
--    definer：把 execute 開給 authenticated，等於任何一個登入中的瀏覽器都能
--    直接對 PostgREST 打 rpc/claim_guest_orders —— 雖然它只能帶自己的 user_id，
--    但那條路徑繞過了 src/server 這一側的全部檢查，而這個 repo 的授權**全部**
--    在那一側。唯一的呼叫者是 service_role（server function）。
revoke all on function public.claim_guest_orders(uuid) from public;
revoke all on function public.claim_guest_orders(uuid) from anon, authenticated;
grant execute on function public.claim_guest_orders(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. 認領用的索引
-- ---------------------------------------------------------------------------
-- 表達式必須與函式裡的 where 逐字一致（lower(trim(...))），否則規劃器對不上，
-- 這個 update 就是全表掃描。partial（where user_id is null）是因為認領只看得到
-- 沒有主人的那些列，而那個集合會隨著時間變小 —— 索引也跟著變小。
--
-- 0005:113 已經有 orders_email_idx (customer_email)，那一支對這裡沒有用：它索引
-- 的是原始值，而這裡比對的是正規化之後的值。
create index if not exists idx_orders_unclaimed_email
  on public.orders (lower(trim(customer_email)))
  where user_id is null;

commit;
