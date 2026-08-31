-- 0021_roster_pii.sql —— 名單的明文出口，以及它一定留下的那筆紀錄
--
-- 前一個 migration：0020_event_sessions_registrations.sql。既有 0001–0020 一律不動
-- （0009／0011／0016／0018／0019／0020 自己的檔頭也都是這樣宣告的）；要改行為就在
-- 這裡 `create or replace` / `alter table` / drop constraint + add constraint。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0  這一期在補的洞
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0020 收了「誰要來」，但**刻意沒有開任何明文出口**：名單頁看得到的電話與信箱
-- 是遮罩過的，而且那個遮罩做在 TypeScript（src/server/repos/event-registrations.ts
-- 的 maskTail／maskEmail）。那是那一期寫明的折衷 —— 明文會進到 Node 行程的記憶體，
-- 只是沒有離開它。
--
-- 這一支把 0019 對廠商做過的那一整套形狀，逐條套用到參加者名單上：
--
--   1. 遮罩搬回 SQL（§2 的 inv.mask_email 與 §3 的 public.admin_event_roster），
--      TS 那兩支函式整段刪掉。明文從此不再進 Node 行程 —— 除了下面兩條**會留下
--      紀錄**的路。
--   2. 單列揭露（§5 reveal_registration_contact）與整場匯出（§6 export_event_roster），
--      兩支都在同一個交易裡**先寫 pii_access_log 再組值**（0019 §4.1）。
--   3. 第九種 staff 權限 event.roster.read（§4）。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0.1  PII 的分界是「遮罩 vs 明文」，不是「列表 vs 匯出」
-- ═══════════════════════════════════════════════════════════════════════════
--
--   動作                     回傳                                 寫 log
--   ─────────────────────────────────────────────────────────────────────
--   名單頁列表               姓名全名 + phone_masked/email_masked   ✗
--   單列「顯示完整聯絡方式」  該列明文                              ✓ attendee_contact
--   CSV 匯出                 全場明文                              ✓ roster_export（一列）
--
-- ⚠️ 為什麼列表不寫 log。0019 §1.1 說得很清楚：pii_access_log 要回答的是「有沒有
--    人在亂查」。名單頁一次顯示 30 個人，每次開頁寫 30 列，三個月之後那張表 99%
--    是例行瀏覽 —— 那會讓它失去唯一的用途。稽核軌跡如果什麼都記，就等於什麼都
--    沒記。所以：**遮罩過的東西不記，明文一定記。**
--
-- ⚠️ 為什麼 CSV 只寫一列而不是每位參加者一列。匯出這個動作的主體是**場次**：
--    「某月某日，某某人把這一場的全部名單帶走了」。拆成 30 列會讓同一件事在稽核
--    畫面上看起來像 30 件事，而且真正重要的那個資訊（一次帶走了整場）反而看不見。
--    subject_table 因此是 public.event_sessions，不是 public.event_registrations。
--
-- ⚠️ 姓名不遮罩。遮了現場點不了名，簽到表就沒有用了。這與 0019 讓廠商名稱明文、
--    只遮識別碼是同一條線：遮罩的對象是「可以拿去冒用的識別碼」，不是「這是誰」。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0.2  保留期限：報名資料不做自動清除
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 與 public.orders 一致（業務紀錄，商業會計法五年）。這與 0019 §9.2 對 ocr-scans
-- 設保留期限**不同**，理由就是那支檔頭的分法：
--
--   「原始個資的副本」要最小化 —— 掃描圖留越久風險越大，所以有保留期限。
--   「業務／稽核紀錄」要可追溯 —— 簽到表與 pii_access_log 屬於後者，刪掉等於
--    銷毀紀錄。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0.3  這一支動到 0019 的兩條 CHECK，但**不動 pii_log_access() 的簽名**
-- ═══════════════════════════════════════════════════════════════════════════
--
-- subject_table 與 reason 兩條 CHECK 各自要多收兩個值，做法是
-- `drop constraint if exists` + `add constraint`（與 0019 §3.7 放寬 0010 的
-- staff_permissions CHECK 完全同一個手法）。
--
-- ⚠️ **pii_log_access() 的參數列一個字都不動。** 它現在是
--    (uuid, text, text, uuid, text, text[], text, text)，而 0019 的 revoke／grant
--    是照著這串簽名寫的。改簽名就得先 `drop function`，而 drop 之後那三行
--    revoke/grant 會指向一個不存在的東西 —— 0019 重跑就會失敗。放寬值域不需要
--    改簽名，所以不改。

begin;

-- ---------------------------------------------------------------------------
-- §1  pii_access_log 的兩條 CHECK 各多收兩個值
-- ---------------------------------------------------------------------------
--
-- subject_table 是白名單而不是自由文字（0019 §1.2：打錯字會變成一筆永遠對不到
-- 任何東西的紀錄，而且不會有人發現）。這一期多兩張表：
--
--   public.event_registrations —— 單列揭露的對象（一位參加者）
--   public.event_sessions      —— 整場匯出的對象（一個場次）
--
-- 兩張都寫成 `public.` 前綴，與既有的 `inv.vendors` 同一個格式：schema 名是這個
-- 值的一部分，少了它就分不出 inv.products 與 public.products。
alter table public.pii_access_log drop constraint if exists pii_access_log_subject_table_check;

alter table public.pii_access_log
  add constraint pii_access_log_subject_table_check
  check (subject_table in (
    'inv.vendors',
    'inv.vendor_bank_accounts',
    'public.event_registrations',
    'public.event_sessions'
  ));

-- 事由。0019 的四種是廠商那一側的（對帳／匯款／報稅／廠商來電），self_service 是
-- 廠商自助入口專用。這一期多兩種，而它們與那五種有一個結構上的差別：
--
--   廠商那五種是**使用者從下拉選單挑的**（inv_vendor_sensitive 的 p_reason 由
--   VendorSensitiveDialog 傳進來）。
--
--   這兩種是**由動作決定的**：按「顯示完整聯絡方式」永遠是 attendee_contact，
--   按「匯出 CSV」永遠是 roster_export。名單只有這兩種看法，讓店員從一個永遠
--   只有一個正確答案的下拉選單裡挑，得到的不是資訊而是雜訊。
--
-- 所以 §5／§6 兩支函式的 p_reason 有 default，而且 UI 沒有事由選單。
alter table public.pii_access_log drop constraint if exists pii_access_log_reason_check;

alter table public.pii_access_log
  add constraint pii_access_log_reason_check
  check (reason in (
    'reconciliation',
    'payment',
    'tax_filing',
    'vendor_enquiry',
    'self_service',
    'attendee_contact',
    'roster_export'
  ));

comment on column public.pii_access_log.reason is
  '五種廠商事由（使用者從下拉選單挑）＋兩種名單事由（由動作決定：attendee_contact=看某一位的聯絡方式，roster_export=帶走整場名單）。一律是列舉，不是自由文字。';

-- ---------------------------------------------------------------------------
-- §2  遮罩：inv.mask_email()
-- ---------------------------------------------------------------------------
--
-- 建在 inv schema，緊挨著 0019 §2 的 inv.mask_tail()。兩個理由：
--
--   · 遮罩是同一件事的兩個規則，放在一起才找得到。
--   · inv **不在 PostgREST 的 db_schema 裡**，所以這支函式從瀏覽器打不到，
--     連 service_role 的 supabase-js client 都打不到。遮罩函式本身沒有敏感性，
--     但「能不能被外面呼叫」少一個是一個。
--
-- ── 為什麼信箱不能用 mask_tail ──────────────────────────────────────────
--
-- 信箱的尾碼是 domain。遮了尾巴等於什麼都沒遮（大家都是 @gmail.com），遮了
-- domain 又會讓「這是不是同一個人」看不出來。所以遮的是 local part，留首碼 1 碼：
--
--     alice@example.com  →  a****@example.com
--     a@example.com      →  *@example.com          （太短，整串變星號）
--     沒有 @ 的字串       →  照 mask_tail(v, 2) 處理
--
-- ⚠️ 這一支修掉了 0020 那份 TypeScript 實作裡的一個真 bug。TS 寫的是
--    `v.slice(0, keepHead) + '*'.repeat(...) + v.slice(-keepTail)`，而 keepTail=0
--    時 `slice(-0)` 等於 `slice(0)` —— **整個 local part 又被接回去一次**，
--    `ab@x.com` 會遮成 `a*ab@x.com`。SQL 的 `right(v, 0)` 回空字串，沒有這個坑。
--    這正是「遮罩寫在資料庫」比「遮罩寫在應用層」更好的那一半：一份實作，
--    一種語意。
create or replace function inv.mask_email(p_value text)
returns text
language sql
immutable
as $$
  with t as (select nullif(btrim(coalesce(p_value, '')), '') as v)
  select case
           when t.v is null then null
           -- 沒有 @，或 @ 就在第一個字元（local part 是空的）：當成一般字串遮尾 2 碼。
           when t.v !~ '^.+@' then inv.mask_tail(t.v, 2)
           else
             -- 以**最後一個** @ 切開。'a@b@c.com' 這種東西不合法但存得進去，
             -- 用第一個 @ 切會讓 domain 看起來是 'b@c.com'。
             coalesce(inv.mask_tail(regexp_replace(t.v, '^(.*)@[^@]*$', '\1'), 0, 1), '*')
             || regexp_replace(t.v, '^.*(@[^@]*)$', '\1')
         end
    from t;
$$;

comment on function inv.mask_email(text) is
  '信箱遮罩：遮 local part、留首碼 1 碼與完整 domain（a****@example.com）。遮尾碼對信箱沒有意義 —— 尾碼是 domain。';

revoke execute on function inv.mask_email(text) from public;
revoke execute on function inv.mask_email(text) from anon, authenticated;
grant  execute on function inv.mask_email(text) to service_role;

-- ---------------------------------------------------------------------------
-- §3  public.admin_event_roster —— 名單頁讀的東西，明文不在裡面
-- ---------------------------------------------------------------------------
--
-- 形狀比照 0019 §3.1 的 inv_admin_vendor_list：`security_invoker = false`，
-- 遮罩寫在 select list 裡，完整值不會離開資料庫。
--
-- security_invoker = false 的意思是這個 view 用 owner（postgres）的身分讀底下的
-- 表。這是必要的：public.event_registrations 是 0020 的 PII 表，**RLS 開著、零
-- policy、anon 與 authenticated 零 grant**，連 service_role 都只有表層的 grant。
-- 用 invoker 身分讀會被 RLS 擋成 0 列。
--
-- ── on_roster：「這一列算不算在簽到表上」的唯一定義 ────────────────────
--
-- ⚠️ 這個欄位是這一期最重要的一行 SQL。
--
-- 快樂手的 app/admin/sessions/queries.ts:117-125 有一段紅字註解，講的是同一件事：
-- 簽到表與提醒信必須用**同一個條件**，否則會出現「有人收到提醒卻不在簽到表上」。
-- 他們的做法是在註解裡要求兩邊一致，而那個要求靠的是下一個人會讀到那段註解。
--
-- 這裡把它變成結構的：條件只寫一次，就寫在這個 view 裡。
--
--   · TypeScript 的 loadPaidRoster()      → where on_roster = true
--   · SQL 的 export_event_roster()（§6）  → where v.on_roster
--   · Phase 3 的提醒信                     → 同一個 on_roster
--
-- 沒有第二個地方寫得出 `payment_status = 'paid'`，所以也沒有第二個地方可以寫錯。
-- scripts/roster-csv-selftest.mjs 有靜態測試守著「'paid' 這個字面值在這一期只
-- 出現一次」。
--
-- ⚠️ payment_status **原樣也留著**，而且名單頁會顯示它。那不是第二個真相 ——
--    on_roster 回答「要不要準備座位」，payment_status 回答「為什麼還有位子卻報
--    不了名」（有 N 個位子被未付款的訂單押著）。後台需要後面那個答案，否則那個
--    問題沒有地方可以回答。
create or replace view public.admin_event_roster
with (security_invoker = false) as
select
  r.id            as registration_id,
  r.session_id    as session_id,
  r.order_id      as order_id,
  r.order_item_id as order_item_id,
  r.seat_no       as seat_no,

  -- ⚠️ 姓名不遮罩，見 §0.1。
  r.name          as name,

  -- ⚠️ 遮罩在這裡，不在前端。完整值不會離開資料庫。
  inv.mask_email(r.email) as email_masked,
  inv.mask_tail(r.phone, 4) as phone_masked,

  -- 「有沒有填」與「填了什麼」是兩件事（同 0019 §3.1 的 has_tax_id）。前者不敏感，
  -- 而且畫面要靠它分辨「這個人沒留電話」與「有留但你看不到」。
  (nullif(btrim(coalesce(r.email, '')), '') is not null) as has_email,
  (nullif(btrim(coalesce(r.phone, '')), '') is not null) as has_phone,

  r.notice_ack_at as notice_ack_at,
  r.created_at    as created_at,

  o.order_no       as order_no,
  o.payment_status as payment_status,
  o.paid_at        as paid_at,

  -- ⚠️ 見上面那一大段。這是「誰在簽到表上」的唯一定義。
  (o.payment_status = 'paid') as on_roster
from public.event_registrations r
join public.orders o on o.id = r.order_id;

comment on view public.admin_event_roster is
  '報名名單（遮罩版）。姓名全名、電話與信箱只有遮罩值 —— 明文只有 reveal_registration_contact() 與 export_event_roster() 給得出來，而那兩支一定留下 pii_access_log。on_roster 是「誰在簽到表上」的唯一定義。只給 service_role。';
comment on column public.admin_event_roster.on_roster is
  '這一列算不算在簽到表上（= 訂單已付款）。畫面、CSV、Phase 3 的提醒信共用這一個定義 —— 兩邊各寫一次條件就是「有人收到提醒卻不在簽到表上」的來源。';
comment on column public.admin_event_roster.payment_status is
  '原樣的付款狀態，給畫面顯示「有 N 個位子被未付款的訂單押著」。不要拿它來判斷簽到表 —— 那是 on_roster 的事。';

revoke all    on public.admin_event_roster from anon, authenticated;
grant  select on public.admin_event_roster to service_role;

-- ---------------------------------------------------------------------------
-- §4  第九種 staff 權限：event.roster.read
-- ---------------------------------------------------------------------------
--
-- 0010 的 staff_permissions.permission CHECK 值域原本是七種 approve_*，0019 §3.7
-- 放寬成八種（多了 inv.vendor.pii.read）。這一期放寬成九種。做法一樣：0010 與
-- 0019 都不動，drop 再 add。**那條 CHECK 才是真正的值域**，src/server/auth.ts 的
-- STAFF_PERMISSIONS 是它的鏡射。
--
-- ── 為什麼名單需要自己的權限 ────────────────────────────────────────────
--
-- 三個維度，現在各有代表：
--
--   approve_*             能不能簽核（七種）
--   inv.vendor.pii.read   能不能看廠商的識別碼
--   event.roster.read     能不能看活動報名名單
--
-- 後兩種都是「能不能看」，但看的是不同人的個資：廠商是合作對象，參加者是客人。
-- 一個負責活動現場的工讀生需要簽到表，沒有理由看到廠商的身分證字號；一個管收貨
-- 的店員兩個都不需要。分開才給得出這種授權。
--
-- admin 自動擁有，與其餘八種一致（requireStaff() 對 admin 不查表）。真正的控制
-- 是 §5／§6 的稽核軌跡 —— admin 看了一樣留紀錄，而且他刪不掉那筆紀錄
-- （0019 §1.3 的 trigger 連 table owner 都擋）。
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
    'inv.vendor.pii.read',
    'event.roster.read'
  ));

comment on column public.staff_permissions.permission is
  '七種 approve_*（能不能簽核）＋ inv.vendor.pii.read（能不能看廠商的完整身分證／統編／銀行帳號）＋ event.roster.read（能不能看活動報名名單）。後兩種都是「能不能看」，但看的是不同人的個資，所以分開。';

-- ---------------------------------------------------------------------------
-- §5  單列明文：reveal_registration_contact()
-- ---------------------------------------------------------------------------
--
-- 形狀逐條對應 0019 §4 的 inv_vendor_sensitive()：security definer、先寫紀錄再
-- 組值、兩件事在同一個交易。於是：
--
--   · 回傳成功 → 交易 commit → 紀錄一定在。
--   · 中途出錯 → 交易 rollback → 紀錄不見了，但**值也沒有送出去**。
--
-- log 與 disclosure 同生共死。稽核軌跡要記錄的是「有沒有人看到」，不是「有沒有
-- 人嘗試看」（嘗試被擋下來是授權層的事，那一層有自己的錯誤訊息）。
--
-- ── 為什麼沒有 p_fields 白名單 ──────────────────────────────────────────
--
-- 廠商那一支有五個敏感欄位，所以「這次看了哪幾個」是有資訊量的問題。參加者只有
-- 兩個（email／phone），而且店員按那顆按鈕的意思一定是「我要聯絡這個人」——
-- 讓他先勾選要 email 還是 phone，只會產生一個永遠勾兩個的介面。所以 fields 固定
-- 記成 array['email','phone']，那就是實際送出去的東西。
--
-- ⚠️ 一次一列，沒有「批次揭露」的版本。要看整場就走 §6，而那會留下一筆長得完全
--    不一樣的紀錄（subject 是場次）。這兩件事在稽核畫面上必須分得出來。
create or replace function public.reveal_registration_contact(
  p_actor_user_id   uuid,
  p_actor_email     text,
  p_registration_id uuid,
  p_reason          text default 'attendee_contact'
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_reg    record;
  v_log_id uuid;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'ROSTER_PII_NO_ACTOR: 讀取參加者聯絡方式必須記錄操作人員';
  END IF;
  IF p_registration_id IS NULL THEN
    RAISE EXCEPTION 'ROSTER_PII_NO_TARGET: 沒有指定要看哪一位參加者';
  END IF;

  SELECT r.id, r.session_id, r.seat_no, r.name, r.email, r.phone
    INTO v_reg
    FROM public.event_registrations r
   WHERE r.id = p_registration_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROSTER_PII_NOT_FOUND: 找不到這一筆報名'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ⚠️ 先寫紀錄，再組值。順序在同一個交易裡其實不影響結果，但寫在前面讓
  --    「這一支一定會 log」變成讀第一眼就看得出來的事（0019 §4.1 的原話）。
  --
  -- subject_label 抄一份姓名下來：報名紀錄哪天被刪了，稽核軌跡還要讀得懂
  -- （同 0019 對 actor_email / subject_label 的處置）。
  v_log_id := public.pii_log_access(
    p_actor_user_id,
    p_actor_email,
    'public.event_registrations',
    p_registration_id,
    v_reg.name,
    array['email', 'phone'],
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'attendee_contact'),
    'staff'
  );

  RETURN jsonb_build_object(
    'registration_id', v_reg.id,
    'session_id',      v_reg.session_id,
    'seat_no',         v_reg.seat_no,
    'log_id',          v_log_id,
    'name',            v_reg.name,
    'email',           v_reg.email,
    'phone',           v_reg.phone
  );
END;
$$;

comment on function public.reveal_registration_contact(uuid, text, uuid, text) is
  '一位參加者的完整聯絡方式。回傳值之前一定先寫一筆 pii_access_log，兩件事在同一個交易 —— 讀成功 ⇔ 有紀錄。';

-- ---------------------------------------------------------------------------
-- §6  整場明文：export_event_roster()
-- ---------------------------------------------------------------------------
--
-- CSV 匯出的資料來源。與 §5 同一個形狀，兩處刻意不同：
--
--   1. subject 是**場次**（見 §0.1）。一次匯出 = 一列紀錄。
--   2. 只回 on_roster 的列（＝已付款）。CSV 是簽到表，未付款的人不會來 ——
--      把他們印進去，現場就會多準備座位與講義。
--
-- ⚠️ **pii_log_access() 必須出現在取名單那句 select 之前。** 這不只是可讀性：
--    這一段是給 scripts/roster-csv-selftest.mjs 的靜態測試看的，它會比對兩者在
--    函式體裡的位置。0019 §4.1 已經論證過為什麼順序在同一個交易裡不影響結果 ——
--    寫在前面是為了讓「這一支一定會 log」讀第一眼就看得出來。
--
-- ⚠️ 回傳的是 jsonb 不是 setof record：呼叫端（src/server/repos/event-registrations.ts）
--    需要的不只是列，還有場次標題與日期（CSV 檔名要用）以及 log_id。分兩次查詢
--    就會出現「log 寫了但列沒拿到」的中間狀態，那正是這個設計要消滅的東西。
create or replace function public.export_event_roster(
  p_actor_user_id uuid,
  p_actor_email   text,
  p_session_id    uuid,
  p_reason        text default 'roster_export'
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_session record;
  v_log_id  uuid;
  v_rows    jsonb;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'ROSTER_EXPORT_NO_ACTOR: 匯出名單必須記錄操作人員';
  END IF;
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'ROSTER_EXPORT_NO_TARGET: 沒有指定要匯出哪一個場次';
  END IF;

  SELECT s.id, s.title, s.starts_at, s.capacity, s.seats_taken
    INTO v_session
    FROM public.event_sessions s
   WHERE s.id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROSTER_EXPORT_NOT_FOUND: 找不到這個場次'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ⚠️ 先寫紀錄。下面那句 select 才是取明文的地方，它在這之後。
  v_log_id := public.pii_log_access(
    p_actor_user_id,
    p_actor_email,
    'public.event_sessions',
    p_session_id,
    coalesce(v_session.title ->> 'zh', v_session.title ->> 'en', '(未命名場次)'),
    array['name', 'email', 'phone'],
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'roster_export'),
    'staff'
  );

  -- 取值。on_roster 來自 §3 的 view —— 「誰在簽到表上」只定義那一次。
  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'registration_id', t.registration_id,
               'seat_no',         t.seat_no,
               'name',            t.name,
               'email',           t.email,
               'phone',           t.phone,
               'notice_ack_at',   t.notice_ack_at,
               'order_no',        t.order_no,
               'paid_at',         t.paid_at,
               'created_at',      t.created_at
             )
             ORDER BY t.created_at, t.seat_no
           ),
           '[]'::jsonb
         )
    INTO v_rows
    FROM (
      SELECT v.registration_id,
             v.seat_no,
             r.name,
             r.email,
             r.phone,
             v.notice_ack_at,
             v.order_no,
             v.paid_at,
             v.created_at
        FROM public.admin_event_roster v
        JOIN public.event_registrations r ON r.id = v.registration_id
       WHERE v.session_id = p_session_id
         AND v.on_roster
    ) t;

  RETURN jsonb_build_object(
    'session_id',    v_session.id,
    'session_title', v_session.title,
    'starts_at',     v_session.starts_at,
    'capacity',      v_session.capacity,
    'seats_taken',   v_session.seats_taken,
    'log_id',        v_log_id,
    'rows',          v_rows
  );
END;
$$;

comment on function public.export_event_roster(uuid, text, uuid, text) is
  '一個場次的完整名單（明文，只含已付款）。回傳值之前一定先寫一筆 pii_access_log，subject 是場次而不是每一位參加者 —— 一次匯出＝一列紀錄。';

-- ---------------------------------------------------------------------------
-- §7  權限
-- ---------------------------------------------------------------------------
-- 與 0019 §1.4／§4、0020 §11 相同處理：PostgreSQL 建立函式時預設把 EXECUTE 授給
-- PUBLIC，所以「從 public revoke」才是真正生效的那一半，anon/authenticated 是保險。
--
-- 這兩支是 security definer，owner 是 postgres —— 它們讀得到 event_registrations，
-- 而呼叫者讀不到。所以「誰執行得了它們」就是「誰看得到明文」，這裡是那道門。
-- 應用層那一道門在 src/lib/admin/fns/event-registrations.ts（event.roster.read）。
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.reveal_registration_contact(uuid, text, uuid, text)',
    'public.export_event_roster(uuid, text, uuid, text)'
  ]
  loop
    execute format('revoke execute on function %s from public', sig);
    execute format('revoke execute on function %s from anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end loop;
end $$;

commit;
