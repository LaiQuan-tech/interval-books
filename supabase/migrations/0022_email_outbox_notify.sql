-- 0022_email_outbox_notify.sql — 交易信的 outbox，與付款成功之後的第三步
--
-- Requires 0005（orders / order_post_payment_log）、0020（event_sessions /
-- event_registrations）、0021（admin_event_roster 的 on_roster）。
--
-- **前一支是 0021_roster_pii.sql。既有的 0001–0021 一律不動** —— 這一支沒有任何
-- `alter` 打在既有的表或函式上，也沒有 `drop`。它只新增一張表、七支函式與一個排程。
-- （唯一寫進既有表的地方是 §8 的回填，那是寫「列」不是改「結構」。）
--
-- ## §0  這一期在補的洞
--
-- 這個站從 0001 到 0021 **一封信都寄不出去**（全 repo grep `resend` / `mail` 零命中）。
-- 客人付完錢看到的是一個轉址頁面，之後什麼都沒有：沒有訂單確認、沒有報名成功、
-- 活動前一天也沒有提醒。0020／0021 剛把「誰報名了哪一場」做出來，而那份名單目前
-- 只有店員在後台看得到 —— 報名的人自己不知道自己報成功了。
--
-- ## §0.1  用掉那個預留了五期沒人碰的 'notify'
--
-- `public.order_post_payment_log.step` 的 CHECK 從 `0005:293` 就是
-- `check (step in ('invoice','logistics','notify'))`，而 **'notify' 從未被寫入過**
-- —— 0007 只寫 'invoice'，0011 的庫存不走這張表，'logistics' 到今天還沒有實作。
-- 這一期把 'notify' 用起來，形狀與 0007 的發票**逐字對應**：
--
--     claim_order_notify()  →  做（排信進 outbox）  →  finish / fail
--
-- 沿用同一張表、同一個 unique(order_id, step) 當鎖，是為了讓「付款之後要做的事」
-- 只有一個地方查得到狀態。加第二張 notify_log 會讓「這張單的後續處理跑到哪了」
-- 變成兩個查詢。
--
-- ## §0.2  為什麼信排最後，而且它的失敗最不嚴重
--
-- webhook 收到付款成功之後依序做三件事（src/server/payuni-webhook.ts）：
--
--     commitInventoryForOrder()      ← 貨（0011）
--     triggerInvoiceAfterPayment()   ← 憑證（0007）
--     triggerNotifyAfterPayment()    ← 信（這一期）
--
-- 順序是有意義的，理由是**失敗的可補救程度**：庫存沒扣，下一個客人就會買到同一本
-- 已經賣掉的書（不可逆，而且傷的是別人）；發票沒開是法遵問題（台灣電商付了錢就要
-- 開發票）。信沒寄出去則有 outbox 的八次重試、有排程、後台也看得到「有 N 封沒寄出
-- 去」—— 它是三件事裡最有辦法事後補的那一件，所以排最後。
--
-- ## §0.3  信不帶發票號碼
--
-- 付款成功信**刻意不含發票號碼**。發票那一步有 8 秒逾時保護（invoice-issuer.ts
-- L413-440），Amego 慢一點就會逾時交給 backlog；如果信要等發票號碼，Amego 一慢
-- 就變成信也不寄。客人拿發票的路徑是財政部的載具與 email（Amego 自己會寄），
-- 而「你的訂單付款成功了」這件事不該被那個外部系統的可用性綁住。
--
-- ## §0.4  相對快樂手 outbox 的兩個改良
--
-- 快樂手（~/.gemini/File/happyhand/apps/web/lib/email/outbox.ts）那一套可以跑，
-- 但有兩件事這裡做得不一樣：
--
--   1. **claim 是一句 SQL，不是「先 select 五列再逐列 CAS」。** 他們先撈五列回
--      Node，再對每一列打一次條件式 update，搶不到就跳過 —— 兩次來回，而且中間
--      那個空窗要靠 `.eq("attempts", row.attempts)` 這種樂觀鎖補。這裡用
--      `update … where id in (select … for update skip locked) returning *`：
--      挑列與佔位是同一句、同一個交易，`skip locked` 讓並行的 flush 直接拿到
--      不相交的批次。§4。
--
--   2. **寄出 30 天後清掉信件內文。** 快樂手沒有做這件事，所以 `body_text` /
--      `body_html` 會永遠躺在資料庫裡 —— 而信裡有收件人姓名、場次、訂單編號，
--      那是**原始個資的副本**，適用 0019 §9.2 對 ocr-scans 那條線（「原始個資的
--      副本」要最小化，「業務／稽核紀錄」要可追溯）。清掉 body 之後 subject /
--      dedupe_key / sent_at 都還在，所以「這封信寄出去了沒有」永遠答得出來。§6。
--
-- ## §0.5  明文 email 一步都不離開資料庫
--
-- 0021 §3 的 `public.admin_event_roster` 只給遮罩值，這是刻意的：
-- `src/server/repos/event-registrations.ts` 從此看不到參加者的明文信箱。
--
-- 但寄信需要地址。而「系統為了寄信而使用這個地址」與「有人在查這個人的資料」
-- **不是同一件事** —— 後者才是 `pii_access_log` 要回答的問題（0019 §1.1）。
-- 每寄一封提醒信就寫一列 pii_access_log，三個月後那張表 99% 是機器寫的，
-- 「有沒有人在亂查」這個問題就再也看不出來了。
--
-- 所以這一期**不動 pii_access_log**（不加 subject_table、不加 reason、更不碰
-- `pii_log_access()` 的簽名），改用另一個形狀：**TypeScript 送進來的是
-- registration_id 與已經排好版的信件內容，地址由 SQL 自己去 join**。
--
--     enqueue_order_email(p_order_id, …)          → 地址 = orders.customer_email
--     enqueue_registration_emails(p_items jsonb)   → 地址 = event_registrations.email
--
-- 兩支都**不回傳地址**，只回傳排進去幾封。明文因此一步都沒有離開資料庫，
-- Node 行程的記憶體裡沒有它，Vercel 的 log 裡當然也不會有。
--
-- 為什麼是 `p_items jsonb` 而不是 `enqueue_session_reminders(p_session_id)`：
-- 信件文案是三語的、而且要進 CMS（§7 的 public.email_copy），如果由 SQL 組信，
-- 排版就得寫在 SQL 裡 —— 那會變成「文案的第二個地方」。這個形狀讓
-- `src/lib/email-templates.ts`（純函式、三語、不 import server-only）保持是唯一
-- 的排版來源，而 SQL 只負責「把地址接上去」這一件它才做得到的事。
--
-- ⚠️ **`enqueue_registration_emails()` 自己 join `admin_event_roster` 並要求
--    `on_roster`。** 也就是說，就算呼叫端傳了一個不在名單上的 registration_id，
--    信也排不進去。「誰在簽到表上」仍然只定義在 0021 §3 的那一行
--    （`o.payment_status = 'paid'`），這裡沒有第二份條件。
--
-- ## §0.6  dedupe_key 就是冪等保證
--
-- `dedupe_key text not null unique`。三封信的格式一律 `<用途>:<實體 id>`：
--
--   | 時機              | dedupe_key                                  | 收件人     |
--   |-------------------|---------------------------------------------|-----------|
--   | 付款成功          | order_paid:<order_id>                        | 訂購人     |
--   | 付款成功（每一位）| registration_ticket:<registration_id>        | 該位參加者 |
--   | 活動前 24 小時    | session_reminder:<session_id>:<registration_id> | 該位參加者 |
--
-- 所有 enqueue 都是 `on conflict (dedupe_key) do nothing`，所以重跑排程、重送
-- webhook、backlog 補跑，全部只會排進去一次。**提醒信因此不需要「這一場提醒過了
-- 沒有」的旗標** —— 每 10 分鐘掃一次、每次都嘗試排入，第二次之後全部撞 unique。
--
-- ## §0.7  排程 '6-56/10 * * * *' —— 三支永遠不撞在同一個 tick
--
-- 這個站現在有三支 pg_cron：
--
--     expire-unpaid-orders    */5        → 分鐘 0,5,10,15,20,25,30,35,40,45,50,55
--     dispatch-invoice-task   3-53/10    → 分鐘 3,13,23,33,43,53
--     dispatch-notify-task    6-56/10    → 分鐘 6,16,26,36,46,56   ← 這一期
--
-- 6,16,26,36,46,56 沒有一個是 5 的倍數（所以不撞 expire），也沒有一個 ≡ 3 (mod 10)
-- （所以不撞 invoice）。三支任兩支的交集都是空的。
--
-- 0008 檔頭已經為 invoice 做過同一次計算，理由也一樣：expire_unpaid_orders() 會對
-- orders 下列鎖，claim_invoice_issue() 與這一期的 claim_order_notify() 也會。撞在
-- 一起不會壞掉（Postgres 會排隊），但會讓「為什麼這一輪特別慢」變得難查。
--
-- 為什麼是 10 分鐘不是 5 分鐘：outbox 的第一次重試是 2 分鐘後（§3 的退避表），
-- 但**正常路徑根本不靠排程** —— webhook 排完信就會立刻 flush 一次，>90% 的客人
-- 是秒收到的。排程收拾的是「webhook 那一次沒寄成」與「活動前 24 小時的提醒」，
-- 兩者都不差那 5 分鐘。跑得更密只是多打幾次外部請求。
--
-- ## §0.8  ⚠️ 這支 migration 不建立 Vault secret
--
-- 與 0008 同一條規矩：migration 進 git，secret 不進 git。套用之前要先手動建一筆
-- **新的** secret（`tasks_secret` 沿用 0008 already 建好的那一筆，不要重建）：
--
--     select vault.create_secret(
--       'https://interval-books.vercel.app/api/tasks/notify',
--       'notify_tasks_endpoint_url',
--       '寄信排程要打的端點（不含 ?k=）');
--
-- 用 vercel.app 而不是自訂網域是刻意的（既有的 `tasks_endpoint_url` 也是這樣）：
-- 排程不依賴 DNS，換網域、改 CNAME、憑證出問題都不會讓信停掉。
--
-- 缺 secret 時 dispatch_notify_task() 會 raise，讓 cron.job_run_details 紅掉 ——
-- 理由同 0008：安靜跳過會讓排程看起來一直是綠的，而一封信都沒送出去。
--
-- ## §0.9  ⚠️ 「排程有跑」不等於「打得到」
--
-- pg_net 是非同步的，`cron.job_run_details` 說 succeeded 只證明請求被排進佇列。
-- 真正的答案在 `net._http_response.status_code`：
--
--     select r.id, r.status_code, r.content, r.created
--       from net._http_response r order by r.id desc limit 5;

begin;

-- ---------------------------------------------------------------------------
-- §1  public.email_outbox —— 每一封交易信的一列
-- ---------------------------------------------------------------------------
--
-- 為什麼不是「在 webhook 裡直接呼叫 Resend」：那一次呼叫沒有重試、沒有紀錄，
-- Resend 掛 30 秒就會有一批客人永遠收不到付款成功信，而且**任何地方都查不到
-- 這件事發生過**。對一個已經收了錢的訂單來說那不可接受。
--
-- outbox 的意思是：排進來（一次資料庫寫入，快、不會失敗）與寄出去（外部 HTTP，
-- 慢、會失敗）拆成兩件事。排進來的那一刻信就「一定會寄」，剩下的是什麼時候。
create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),

  -- ⚠️ 冪等保證就是這一行。格式 `<用途>:<實體 id>`，見檔頭 §0.6。
  --    所有 enqueue 都是 on conflict do nothing，所以同一把鑰匙只會有一列。
  dedupe_key text not null unique,

  -- ⚠️ 這一欄是明文個資，而且是這張表唯一的明文欄位。它只由 §5 的兩支 enqueue
  --    函式從 orders / event_registrations join 進來，**沒有任何路徑會把它回傳
  --    給呼叫端**（claim_email_batch 例外，而那是寄信本身必須的）。
  to_email text not null check (btrim(to_email) <> ''),

  subject text not null,

  -- 內文預設空字串而不是 null：§6 清掉內文之後這兩欄會變成 ''，而「空字串」與
  -- 「從來沒有內文」在查詢上長得一樣 —— 所以另外用 body_purged_at 分辨。
  body_text text not null default '',
  body_html text not null default '',

  -- pending  還沒寄（或失敗但還有重試額度）
  -- sent     真的送出去了，有 provider_id
  -- failed   重試到上限，放棄。後台總覽要顯示「有 N 封信寄不出去」
  -- skipped  **刻意沒寄**：本機／預覽環境沒有 RESEND_API_KEY 時走 dry run
  --          ⚠️ dry run 標 'skipped' 而不是 'sent' 是這一期與快樂手不同的地方
  --             （他們標 sent）。標成 sent 的話，一個忘了設 API key 的正式環境
  --             會顯示「全部寄出成功」，而實際上一封都沒出去 —— 那正是這個 repo
  --             一路在防的「綠燈但什麼都沒做」。
  status text not null default 'pending'
    constraint email_outbox_status_valid
    check (status in ('pending', 'sent', 'failed', 'skipped')),

  attempts int not null default 0
    constraint email_outbox_attempts_nonneg check (attempts >= 0),
  last_error text,
  provider_id text,

  next_attempt_at timestamptz not null default now(),
  sent_at         timestamptz,

  -- 內文被 §6 清掉的時間。null = 內文還在（或本來就沒有內文）。
  body_purged_at  timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.email_outbox is
  '交易信的收件匣。dedupe_key 唯一 = 冪等保證。to_email 是明文個資，只由 enqueue_* 函式從 orders / event_registrations join 進來。寄出 30 天後 body_* 由 purge_sent_email_bodies() 清掉。';
comment on column public.email_outbox.dedupe_key is
  '冪等鍵，格式 <用途>:<實體 id>。order_paid:<order_id> / registration_ticket:<registration_id> / session_reminder:<session_id>:<registration_id>。';
comment on column public.email_outbox.status is
  'skipped = 刻意沒寄（沒有 RESEND_API_KEY 的 dry run）。不要把它併進 sent —— 後台要看得出「有 N 封沒寄出去」。';
comment on column public.email_outbox.body_purged_at is
  '內文被 purge_sent_email_bodies() 清掉的時間。分辨「內文清掉了」與「本來就沒內文」。';

-- 待寄清單的 partial index：flush 每次都是這個條件。
create index if not exists email_outbox_due_idx
  on public.email_outbox (next_attempt_at)
  where status = 'pending';

-- 清內文用的 partial index。已經清過的列不再進來。
create index if not exists email_outbox_purgeable_idx
  on public.email_outbox (sent_at)
  where body_purged_at is null and status in ('sent', 'skipped');

-- 後台總覽「有 N 封寄不出去」。
create index if not exists email_outbox_status_idx
  on public.email_outbox (status, created_at desc);

drop trigger if exists email_outbox_set_updated_at on public.email_outbox;
create trigger email_outbox_set_updated_at
  before update on public.email_outbox
  for each row execute function public.set_updated_at();

-- RLS：與 0005 的電商表、0020 的 event_registrations 同一個形狀 —— **開著、零
-- policy、anon 與 authenticated 零 grant**。瀏覽器沒有任何一條查詢打得到收件地址。
alter table public.email_outbox enable row level security;
revoke all on table public.email_outbox from anon, authenticated;
grant all  on table public.email_outbox to service_role;

-- ---------------------------------------------------------------------------
-- §2  public.email_copy —— 信件文案，三語，進 CMS
-- ---------------------------------------------------------------------------
--
-- 形狀刻意抄 0001 的 `public.ui_strings`（group_key / string_key / value jsonb +
-- is_localized 的 CHECK），這樣之後要做後台編輯頁，就是把 _shell.strings.tsx
-- 複製一份改表名。
--
-- 為什麼不直接放進 ui_strings：那張表整張會被 src/lib/cms.ts 讀進 SiteContent，
-- 也就是會跟著 SSR 的 HTML 送到每一個訪客的瀏覽器。信件文案不該出現在那裡 ——
-- 它跟前台一個字都沒有關係，而且會白白讓每一頁變大。
--
-- ⚠️ 這裡的文案**全部是佔位**，正式文案 user 還沒給。每一段都以「（待補：…）」
--    開頭，所以在後台、在信裡、在測試輸出裡都一眼看得出來還沒填。
--    en / ja 先放中文佔位，因為 is_localized() 要求三語都非空（0001:56-70）——
--    那個約束是對的，這裡不為了省事去繞過它。
--
-- src/lib/email-templates.ts 有一份同樣內容的 DEFAULT_EMAIL_COPY 常數當 fallback，
-- 形狀與 src/lib/cms.ts 對 src/i18n/strings.ts 的關係一樣：DB 有值就用 DB 的，
-- 缺了的 key 用內建值補。所以這張表就算一列都沒有，信仍然寄得出去。
create table if not exists public.email_copy (
  template_key text not null
    constraint email_copy_template_valid
    check (template_key in ('common', 'order_paid', 'registration_ticket', 'session_reminder')),
  string_key text not null,
  value      jsonb not null constraint email_copy_value_localized check (public.is_localized(value)),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (template_key, string_key)
);

comment on table public.email_copy is
  '交易信的三語文案。形狀同 public.ui_strings，但刻意不併進去 —— ui_strings 整張會被 cms.ts 送到瀏覽器。src/lib/email-templates.ts 的 DEFAULT_EMAIL_COPY 是 fallback。';

create index if not exists email_copy_template_idx
  on public.email_copy (template_key, sort_order);

drop trigger if exists email_copy_set_updated_at on public.email_copy;
create trigger email_copy_set_updated_at
  before update on public.email_copy
  for each row execute function public.set_updated_at();

alter table public.email_copy enable row level security;
revoke all on table public.email_copy from anon, authenticated;
grant all  on table public.email_copy to service_role;

-- 佔位文案。on conflict do nothing —— 重跑 migration 不會蓋掉 user 之後填的正式文案。
insert into public.email_copy (template_key, string_key, value, sort_order) values
  ('common', 'signature',
   '{"zh":"（待補：信末署名）小時光書店","en":"（待補：信末署名）小時光書店","ja":"（待補：信末署名）小時光書店"}'::jsonb, 10),
  ('common', 'footerNote',
   '{"zh":"（待補：頁尾說明，例如「本信件由系統自動發送，回信將寄至小時光團隊」）","en":"（待補：頁尾說明）","ja":"（待補：頁尾說明）"}'::jsonb, 20),

  ('order_paid', 'subject',
   '{"zh":"（待補：付款成功信主旨）訂單 {orderNo} 付款完成","en":"（待補：付款成功信主旨）Order {orderNo} paid","ja":"（待補：付款成功信主旨）ご注文 {orderNo} のお支払い完了"}'::jsonb, 10),
  ('order_paid', 'heading',
   '{"zh":"（待補：付款成功信標題）我們收到您的付款了","en":"（待補：付款成功信標題）We have received your payment","ja":"（待補：付款成功信標題）お支払いを確認しました"}'::jsonb, 20),
  ('order_paid', 'intro',
   '{"zh":"（待補：付款成功信開頭段落）","en":"（待補：付款成功信開頭段落）","ja":"（待補：付款成功信開頭段落）"}'::jsonb, 30),
  ('order_paid', 'outro',
   '{"zh":"（待補：付款成功信結尾段落，例如出貨與取件說明）","en":"（待補：付款成功信結尾段落）","ja":"（待補：付款成功信結尾段落）"}'::jsonb, 40),

  ('registration_ticket', 'subject',
   '{"zh":"（待補：報名成功信主旨）報名完成：{sessionTitle}","en":"（待補：報名成功信主旨）Registered: {sessionTitle}","ja":"（待補：報名成功信主旨）お申し込み完了：{sessionTitle}"}'::jsonb, 10),
  ('registration_ticket', 'heading',
   '{"zh":"（待補：報名成功信標題）您的報名已完成","en":"（待補：報名成功信標題）Your registration is confirmed","ja":"（待補：報名成功信標題）お申し込みが完了しました"}'::jsonb, 20),
  ('registration_ticket', 'intro',
   '{"zh":"（待補：報名成功信開頭段落）","en":"（待補：報名成功信開頭段落）","ja":"（待補：報名成功信開頭段落）"}'::jsonb, 30),
  ('registration_ticket', 'outro',
   '{"zh":"（待補：報名成功信結尾段落，例如當天報到方式與注意事項）","en":"（待補：報名成功信結尾段落）","ja":"（待補：報名成功信結尾段落）"}'::jsonb, 40),

  ('session_reminder', 'subject',
   '{"zh":"（待補：活動提醒信主旨）明天見：{sessionTitle}","en":"（待補：活動提醒信主旨）See you tomorrow: {sessionTitle}","ja":"（待補：活動提醒信主旨）明日開催：{sessionTitle}"}'::jsonb, 10),
  ('session_reminder', 'heading',
   '{"zh":"（待補：活動提醒信標題）活動就在明天","en":"（待補：活動提醒信標題）Your event is tomorrow","ja":"（待補：活動提醒信標題）イベントは明日です"}'::jsonb, 20),
  ('session_reminder', 'intro',
   '{"zh":"（待補：活動提醒信開頭段落）","en":"（待補：活動提醒信開頭段落）","ja":"（待補：活動提醒信開頭段落）"}'::jsonb, 30),
  ('session_reminder', 'outro',
   '{"zh":"（待補：活動提醒信結尾段落，例如交通與聯絡方式）","en":"（待補：活動提醒信結尾段落）","ja":"（待補：活動提醒信結尾段落）"}'::jsonb, 40)
on conflict (template_key, string_key) do nothing;

-- ---------------------------------------------------------------------------
-- §3  退避：public.email_backoff_minutes()
-- ---------------------------------------------------------------------------
--
-- 第 n 次失敗之後隔多久再試（分鐘）：2^n，上限 6 小時。
--
--     1 → 2 分    2 → 4 分    3 → 8 分    4 → 16 分
--     5 → 32 分   6 → 64 分   7 → 128 分  8 → 256 分
--
-- 上限 360 分（6 小時）在 n=9 才會咬到，而 MAX_ATTEMPTS 是 8，所以實務上碰不到 ——
-- 留著是因為這支函式的定義本身要是完整的，不能靠「呼叫端不會傳到那麼大」。
--
-- ⚠️ 指數也一起夾在 12：`2 ^ 100` 是合法的 numeric，但 `::integer` 會溢位並
--    raise，而那會讓整個 claim 失敗（而不是「這封信晚一點再試」）。2^12 = 4096
--    已經遠大於 360，所以夾在 12 不改變任何一個實際會用到的答案。同一句話反過來
--    說：如果只寫 least(360, …) 而不夾指數，「上限 360」這件事就是靠呼叫端不亂傳
--    才成立的 —— 那正是上一段拒絕的那種保證。
--
-- 八次的總等待約 7.5 小時。一個真的壞掉的信箱（打錯字、網域不存在）會在那之後被
-- 標成 failed 讓人看到；一次 Resend 的短暫故障則在前兩三次就自己救回來了。
create or replace function public.email_backoff_minutes(p_attempts integer)
returns integer
language sql
immutable
security invoker
set search_path = ''
as $$
  select least(360, (2::numeric ^ least(greatest(coalesce(p_attempts, 1), 1), 12))::integer);
$$;

comment on function public.email_backoff_minutes(integer) is
  '第 n 次失敗後的退避分鐘數（2^n，上限 360）。claim_email_batch() 在佔位時就把 next_attempt_at 推到未來。';

-- ---------------------------------------------------------------------------
-- §4  public.claim_email_batch() —— 挑列與佔位是同一句 SQL
-- ---------------------------------------------------------------------------
--
-- 這是相對快樂手的第一個改良（檔頭 §0.4）。他們的做法是：
--
--     select … where status='pending' limit 5        ← 第一次來回
--     for each row: update … where attempts = 舊值    ← 第二次來回，逐列
--
-- 兩次來回之間有一個空窗，所以第二步得帶上樂觀鎖條件，而搶輸的那一列要另外
-- 記成 skipped。這裡用一句：
--
--     update … where id in (select … for update skip locked) returning *
--
-- `for update skip locked` 讓兩個並行的 flush 直接拿到**不相交**的批次 —— 不需要
-- 樂觀鎖、不會有搶輸的列、也不會有一列被兩個 flush 各寄一次。
--
-- ⚠️ 佔位的定義是「把 next_attempt_at 推到未來」，而不是加一個 'sending' 狀態。
--    理由與 0007 的 reclaim_stale_invoices 相反著看：多一個中間狀態，就多一種
--    「程序被砍掉之後卡在那裡沒人接手」的可能。推 next_attempt_at 的話，行程死掉
--    的最壞結果是這封信晚 2^n 分鐘再試 —— 自己會好。
--
-- ⚠️ attempts 在**送出之前**就 +1，不是送出之後。這是刻意的：如果 +1 放在成功
--    之後，一個每次都讓行程當掉的信（超大附件、某種會炸的字元）會被無限重試。
create or replace function public.claim_email_batch(p_limit integer default 5)
returns table (
  id         uuid,
  dedupe_key text,
  to_email   text,
  subject    text,
  body_text  text,
  body_html  text,
  attempts   integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_limit is null or p_limit <= 0 then
    raise exception 'INVALID_LIMIT:%', p_limit;
  end if;

  return query
  update public.email_outbox o
     set attempts        = o.attempts + 1,
         next_attempt_at = now()
                           + make_interval(mins => public.email_backoff_minutes(o.attempts + 1))
   where o.id in (
     select e.id
       from public.email_outbox e
      where e.status = 'pending'
        and e.next_attempt_at <= now()
      order by e.next_attempt_at
      limit p_limit
        for update skip locked
   )
  returning o.id, o.dedupe_key, o.to_email, o.subject, o.body_text, o.body_html, o.attempts;
end;
$$;

comment on function public.claim_email_batch(integer) is
  '原子地佔住最多 p_limit 封待寄信並回傳內容。挑列與佔位是同一句 update（for update skip locked），所以並行的 flush 拿到不相交的批次。attempts 在送出之前就 +1。';

-- ---------------------------------------------------------------------------
-- §5  finish / fail
-- ---------------------------------------------------------------------------
--
-- 與 0007 的 finish_invoice_issue / fail_invoice_issue 同一組概念：拿到 claim 的人
-- **一定要走到其中一個**。差別在於發票是「開出去撤不回來」，信則是「重寄一次只是
-- 客人多收一封」—— 所以這裡不需要 0007 那個 DOUBLE_ISSUE 的絆線。
create or replace function public.finish_email(
  p_id          uuid,
  p_provider_id text default null,
  p_skipped     boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_ok boolean;
begin
  update public.email_outbox o
     set status      = case when p_skipped then 'skipped' else 'sent' end,
         sent_at     = now(),
         provider_id = p_provider_id,
         last_error  = null
   where o.id = p_id
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

comment on function public.finish_email(uuid, text, boolean) is
  '標記一封信已處理完。p_skipped=true 標 skipped（沒有 RESEND_API_KEY 的 dry run），不是 sent —— 後台要看得出有幾封刻意沒寄。';

-- p_max_attempts 到頂就標 failed。沒到頂就留在 pending，next_attempt_at 已經
-- 由 claim_email_batch 推到未來了，所以這裡不需要再算一次退避。
create or replace function public.fail_email(
  p_id           uuid,
  p_error        text,
  p_max_attempts integer default 8
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_status text;
begin
  update public.email_outbox o
     set status     = case when o.attempts >= p_max_attempts then 'failed' else 'pending' end,
         last_error = left(coalesce(p_error, 'unknown'), 500)
   where o.id = p_id
  returning o.status into v_status;

  return coalesce(v_status, 'missing');
end;
$$;

comment on function public.fail_email(uuid, text, integer) is
  '記錄一次寄送失敗。attempts 已達上限就標 failed（後台顯示「有 N 封寄不出去」），否則留在 pending 等下一輪。';

-- ---------------------------------------------------------------------------
-- §6  purge_sent_email_bodies() —— 寄出 30 天後清掉內文
-- ---------------------------------------------------------------------------
--
-- 快樂手沒有做這件事（檔頭 §0.4）。
--
-- 信件內文裡有收件人姓名、場次名稱與時間、訂單編號 —— 那是**原始個資的副本**，
-- 而副本要最小化。0019 §9.2 對 ocr-scans 用的是同一條線，而且那支檔頭已經寫清楚
-- 分法：「原始個資的副本」要最小化，「業務／稽核紀錄」要可追溯。
--
-- 所以清掉的是 body_text / body_html，**保留** subject / dedupe_key / sent_at /
-- provider_id：「這封信寄給誰、什麼時候寄的、寄成功了沒有」永遠答得出來，而
-- 「信裡寫了什麼」在 30 天後就不需要了（爭議通常在收到信的當週就發生）。
--
-- ⚠️ to_email **不清**。它是 dedupe_key 之外辨識這一列的唯一依據，清掉之後
--    「這封信到底寄到哪裡」就永遠答不出來了 —— 而那正是客訴時要回答的問題。
--    報名資料本身也不做自動清除（0021 §0.2，業務紀錄，商業會計法五年）。
--
-- ⚠️ 冪等：body_purged_at is null 是條件之一，所以重跑只會發現沒有東西可清。
create or replace function public.purge_sent_email_bodies(
  p_older_than interval default '30 days'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  with purged as (
    update public.email_outbox o
       set body_text      = '',
           body_html      = '',
           body_purged_at = now()
     where o.status in ('sent', 'skipped')
       and o.sent_at is not null
       and o.sent_at < now() - p_older_than
       and o.body_purged_at is null
    returning o.id
  )
  select count(*)::integer into v_count from purged;

  return coalesce(v_count, 0);
end;
$$;

comment on function public.purge_sent_email_bodies(interval) is
  '寄出 p_older_than 之後清掉 body_text / body_html，保留 subject / dedupe_key / sent_at / to_email。信件內文是原始個資的副本（0019 §9.2 的線）。冪等。';

-- ---------------------------------------------------------------------------
-- §7  enqueue —— 地址由 SQL 自己 join，不從呼叫端傳進來
-- ---------------------------------------------------------------------------
--
-- 見檔頭 §0.5。兩支都**不回傳地址**，只回傳排進去幾封。

-- 訂購人的信（付款成功）。地址來自 orders.customer_email。
create or replace function public.enqueue_order_email(
  p_order_id   uuid,
  p_dedupe_key text,
  p_subject    text,
  p_body_text  text,
  p_body_html  text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_ok boolean;
begin
  if p_dedupe_key is null or btrim(p_dedupe_key) = '' then
    raise exception 'EMPTY_DEDUPE_KEY';
  end if;

  insert into public.email_outbox (dedupe_key, to_email, subject, body_text, body_html)
  select p_dedupe_key, o.customer_email, p_subject,
         coalesce(p_body_text, ''), coalesce(p_body_html, '')
    from public.orders o
   where o.id = p_order_id
     and nullif(btrim(coalesce(o.customer_email, '')), '') is not null
  on conflict (dedupe_key) do nothing
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

comment on function public.enqueue_order_email(uuid, text, text, text, text) is
  '把一封信排給訂購人。地址從 orders.customer_email join 進來，不回傳。回 true 代表這一次真的新增了一列（false = dedupe_key 已存在，或這張訂單沒有信箱）。';

-- 參加者的信（報名成功 / 活動前提醒）。地址來自 event_registrations.email。
--
-- ⚠️ **join public.admin_event_roster 並要求 on_roster。** 「誰在簽到表上」仍然
--    只定義在 0021 §3 的那一行，這裡沒有第二份條件。呼叫端就算傳了一個未付款的
--    registration_id，信也排不進去 —— 這條規則是結構性的，不是靠呼叫端自律。
--
-- ⚠️ 沒有信箱的參加者被安靜跳過，不是錯誤。0020 的
--    event_registrations_contactable 只要求 email 與 phone **至少有一個**，
--    所以「只留電話」是合法的報名。那些人收不到信，這是資料本身的結果。
--    回傳值（實際排進去幾封）讓呼叫端看得出差額。
create or replace function public.enqueue_registration_emails(p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'ITEMS_NOT_ARRAY';
  end if;

  with inserted as (
    insert into public.email_outbox (dedupe_key, to_email, subject, body_text, body_html)
    select i.dedupe_key, r.email, i.subject,
           coalesce(i.body_text, ''), coalesce(i.body_html, '')
      from jsonb_to_recordset(p_items) as i(
             registration_id uuid,
             dedupe_key      text,
             subject         text,
             body_text       text,
             body_html       text
           )
      join public.admin_event_roster v on v.registration_id = i.registration_id
      join public.event_registrations r on r.id = i.registration_id
     where v.on_roster
       and nullif(btrim(coalesce(r.email, '')), '') is not null
       and nullif(btrim(coalesce(i.dedupe_key, '')), '') is not null
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_count from inserted;

  return coalesce(v_count, 0);
end;
$$;

comment on function public.enqueue_registration_emails(jsonb) is
  '把一批信排給參加者。地址從 event_registrations.email join 進來，不回傳。on_roster 是唯一的名單定義（0021 §3），不在名單上的排不進去。只有 email 的人才會排入 —— 只留電話是合法的報名。';

-- ---------------------------------------------------------------------------
-- §8  claim_order_notify / finish / fail —— 形狀逐字對應 0007
-- ---------------------------------------------------------------------------
--
-- 0007 有三道閘門（orders 列鎖 → order_post_payment_log 的 upsert-claim →
-- invoices 的 CAS）。這裡只有前兩道，因為**沒有第三張表**：信的狀態在 outbox 的
-- 每一列上，而 outbox 自己就是冪等的（dedupe_key）。第三道閘門在 0007 存在的理由
-- 是「發票不可以開兩張」，而信重寄一次只是客人多收一封。
--
-- 閘門 1（orders for update）仍然保留，理由與 0007 完全相同：用訂單列本身當
-- 序列化點，兩個並行的 claim 一定有一個先拿到列鎖。少了它，兩邊會同時讀到
-- 「還沒有 notify 列」，接著各自去搶 upsert —— unique 仍然會擋掉一個，但擋掉的
-- 那一個會誤以為「是別人做完了」而不是「我輸了這一局」。
create or replace function public.claim_order_notify(
  p_order_id    uuid,
  p_stale_after interval default '5 minutes'
)
returns table (
  claimed  boolean,
  reason   text,
  order_no text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  public.orders%rowtype;
  v_log_id bigint;
  v_done   timestamptz;
begin
  if p_order_id is null then
    raise exception 'NULL_ORDER_ID';
  end if;

  -- ---- 閘門 1：訂單列鎖，兼檢查「真的付過錢」 ---------------------------
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    return query select false, 'order_not_found', null::text;
    return;
  end if;
  if v_order.payment_status <> 'paid' then
    return query select false, 'order_not_paid', v_order.order_no;
    return;
  end if;

  -- ---- 閘門 2：order_post_payment_log 的 upsert-claim（形狀抄 0007:118-130）
  -- 只有「沒完成，而且（上次失敗過 or claim 已過期）」的列准被接手。正在跑的
  -- claim 兩個條件都不符，DO UPDATE 一列也不影響，RETURNING 沒有列。
  insert into public.order_post_payment_log (order_id, step)
  values (p_order_id, 'notify')
  on conflict (order_id, step) do update
     set claimed_at = now(), error_message = null
   where order_post_payment_log.completed_at is null
     and (order_post_payment_log.error_message is not null
          or order_post_payment_log.claimed_at < now() - p_stale_after)
  returning id into v_log_id;

  if v_log_id is null then
    -- 分辨「已經做完了」與「有人正在做」。0007 用 invoices.status 分，這裡看
    -- completed_at —— 兩者在呼叫端的意義不同：already_sent 是成功（冪等），
    -- locked 只是這一次什麼都不要做。
    select l.completed_at into v_done
      from public.order_post_payment_log l
     where l.order_id = p_order_id and l.step = 'notify';

    if v_done is not null then
      return query select false, 'already_sent', v_order.order_no;
    else
      return query select false, 'locked', v_order.order_no;
    end if;
    return;
  end if;

  return query select true, 'claimed', v_order.order_no;
end;
$$;

comment on function public.claim_order_notify(uuid, interval) is
  '寄付款通知前的原子 claim：訂單列鎖 + order_post_payment_log 的 notify 佔位，同一交易。claimed=true 才可以排信。形狀對應 0007 的 claim_invoice_issue。';

create or replace function public.finish_order_notify(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_ok boolean;
begin
  update public.order_post_payment_log l
     set completed_at  = now(),
         error_message = null
   where l.order_id = p_order_id
     and l.step = 'notify'
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

comment on function public.finish_order_notify(uuid) is
  '結掉 notify claim。「完成」的意思是信已經排進 email_outbox，不是已經送達 —— 送達與否在 outbox 的每一列上。';

-- 失敗留下 `completed_at is null 且 error_message is not null`，那同時是
-- 「可以再搶」的訊號與「這張出過事」的證據（0007 檔頭的原話）。
create or replace function public.fail_order_notify(p_order_id uuid, p_error text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_ok boolean;
begin
  update public.order_post_payment_log l
     set error_message = left(coalesce(p_error, 'unknown'), 500)
   where l.order_id = p_order_id
     and l.step = 'notify'
     and l.completed_at is null
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

comment on function public.fail_order_notify(uuid, text) is
  '記錄排信失敗並釋放 claim（留下 error_message 當待處理標記）。notify_backlog() 用同一個條件撈。';

-- ---------------------------------------------------------------------------
-- §9  notify_backlog() —— 付了錢卻還沒排信的訂單
-- ---------------------------------------------------------------------------
--
-- 定義與 0007 的 invoice_backlog 對稱：worker 與人工排查共用同一句查詢，免得
-- 「排程認為沒事、後台卻看得到卡住的單」。
create or replace function public.notify_backlog(
  p_limit       integer  default 20,
  p_stale_after interval default '5 minutes'
)
returns table (
  order_id      uuid,
  order_no      text,
  paid_at       timestamptz,
  error_message text
)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.order_no, o.paid_at, l.error_message
    from public.orders o
    left join public.order_post_payment_log l
           on l.order_id = o.id and l.step = 'notify'
   where o.payment_status = 'paid'
     and (
       l.id is null
       or (l.completed_at is null
           and (l.error_message is not null
                or l.claimed_at < now() - p_stale_after))
     )
   order by o.paid_at nulls last
   limit greatest(p_limit, 0);
$$;

comment on function public.notify_backlog(integer, interval) is
  '已付款但還沒排出通知信的訂單。worker 與人工排查的共同定義（對稱於 0007 的 invoice_backlog）。';

-- ---------------------------------------------------------------------------
-- §10  回填：這一期之前就付過款的訂單，一律標成「已處理」
-- ---------------------------------------------------------------------------
--
-- ⚠️ **沒有這一段，套用 migration 的當下就會寄信給每一位歷史客人。**
--
-- notify_backlog() 的條件是「已付款 + 沒有 notify 列」，而 0001–0021 期間**沒有
-- 任何東西寫過 notify 列**（檔頭 §0.1）。所以套用之後第一次排程一跑，正式庫裡
-- 每一張歷史已付款訂單都會被判定成「還沒通知」，然後收到一封幾個月前的訂單
-- 付款成功信。那是最糟的那種上線事故：不可撤回、直接寄到真人信箱、而且量很大。
--
-- 這裡把它們一次補成「已完成」，並在 error_message 留下為什麼。
-- completed_at 與 error_message 同時有值是刻意的：它讀起來就是「這一步被關掉了，
-- 原因在這裡」，比只寫 completed_at（那等於謊稱寄過了）誠實。
--
-- ── ⚠️ 為什麼需要一個「上線時間」而不是直接 `where payment_status = 'paid'` ──
--
-- `on conflict (order_id, step) do nothing` 讓這句 insert **不會出錯**，但那不等於
-- 冪等。第二次套用這支 migration 時（重跑整個 migrations 資料夾就會發生，四支
-- 自檢的 APPLY 段每次都在做這件事），第一次套用**之後**才付款的那些訂單還沒有
-- notify 列 —— 它們會被這句 insert 一起補成「已完成」，於是那幾位客人**永遠收不到
-- 付款成功信**，而且完全不會報錯。
--
-- 這一條是實測出來的：notify-selftest [20a] 的最後一條斷言就是為它加的，加上去
-- 的當下它是紅的。
--
-- 所以記一個上線時間，回填只碰在那之前付款的訂單。時間本身只在**第一次**套用時
-- 被寫下來（`on conflict do nothing`），之後重跑幾次都是同一個值。
create table if not exists public.notify_epoch (
  id         smallint primary key check (id = 1),
  started_at timestamptz not null default now()
);

comment on table public.notify_epoch is
  '寄信機制上線的時間，只有一列。存在的唯一理由是讓 0022 §10 的回填可以重複套用：回填只碰這個時間之前付款的訂單，所以第二次套用不會把新客人的通知也關掉。';

insert into public.notify_epoch (id) values (1) on conflict (id) do nothing;

alter table public.notify_epoch enable row level security;
revoke all    on table public.notify_epoch from anon, authenticated;
grant  select on table public.notify_epoch to service_role;

-- coalesce(paid_at, created_at)：payment_status='paid' 但 paid_at 是 null 的列在
-- 理論上不該存在（markOrderPaid 一定會寫），但如果有，用 created_at 判斷仍然正確
-- —— 上線之後才建立的訂單不可能是「歷史訂單」。少了 coalesce 的話，那種列會在
-- **每一次**套用時都被回填一次，也就是上面那個坑的另一個入口。
insert into public.order_post_payment_log (order_id, step, claimed_at, completed_at, error_message)
select o.id, 'notify', now(), now(),
       'skipped_backfill: 這張訂單在 0022（寄信機制）上線之前就已經付款，不補寄'
  from public.orders o
 cross join public.notify_epoch e
 where o.payment_status = 'paid'
   and coalesce(o.paid_at, o.created_at) < e.started_at
on conflict (order_id, step) do nothing;

-- ---------------------------------------------------------------------------
-- §11  sessions_due_for_reminder() —— 活動前 24 小時要提醒哪幾場
-- ---------------------------------------------------------------------------
--
-- ⚠️ 這支**不回傳任何個資**，只回傳場次。誰要收信由
--    src/server/repos/event-registrations.ts 的 loadPaidRoster() 決定
--    （0021 §3 的 on_roster），地址由 §7 的 enqueue_registration_emails() join。
--
-- ⚠️ **沒有「這一場提醒過了沒有」的旗標。** 冪等來自 dedupe_key
--    （`session_reminder:<session_id>:<registration_id>`）：排程每 10 分鐘掃一次，
--    第二次之後全部撞 unique 變成 no-op。多一個旗標欄位就多一個會與真實狀態
--    對不上的地方 —— 例如「旗標設了但信其實沒排進去」。
--
-- 只看 status='open' 的場次：closed 的場次要嘛還沒開賣（0020 §4.4 回填出來的那批
-- starts_at=now()、status='closed'），要嘛被店員關掉了。兩種都不該發提醒。
create or replace function public.sessions_due_for_reminder(
  p_lead  interval default '24 hours',
  p_limit integer  default 50
)
returns table (
  session_id uuid,
  product_id text,
  title      jsonb,
  location   jsonb,
  starts_at  timestamptz,
  ends_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.product_id, s.title, s.location, s.starts_at, s.ends_at
    from public.event_sessions s
   where s.status = 'open'
     and s.starts_at > now()
     and s.starts_at <= now() + p_lead
   order by s.starts_at
   limit greatest(p_limit, 0);
$$;

comment on function public.sessions_due_for_reminder(interval, integer) is
  '未來 p_lead 之內要開始的場次。不含任何個資 —— 誰收信由 loadPaidRoster() 決定，地址由 enqueue_registration_emails() join。冪等來自 dedupe_key，沒有「提醒過了沒有」的旗標。';

-- ---------------------------------------------------------------------------
-- §12  權限：SECURITY DEFINER，所以絕不能讓瀏覽器的金鑰碰得到
-- ---------------------------------------------------------------------------
-- 與 0004 / 0006 / 0007 / 0019 / 0021 相同處理：execute 預設就 grant 給 public，
-- 所以「從 public revoke」才是真正生效的那一半，anon / authenticated 是保險。
--
-- email_backoff_minutes 是 security invoker 的純算術，沒有 definer 風險，但一樣
-- 收掉 —— 它是 public schema 的函式，PostgREST 會把它當 RPC 端點暴露出去。
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.email_backoff_minutes(integer)',
    'public.claim_email_batch(integer)',
    'public.finish_email(uuid, text, boolean)',
    'public.fail_email(uuid, text, integer)',
    'public.purge_sent_email_bodies(interval)',
    'public.enqueue_order_email(uuid, text, text, text, text)',
    'public.enqueue_registration_emails(jsonb)',
    'public.claim_order_notify(uuid, interval)',
    'public.finish_order_notify(uuid)',
    'public.fail_order_notify(uuid, text)',
    'public.notify_backlog(integer, interval)',
    'public.sessions_due_for_reminder(interval, integer)'
  ]
  loop
    execute format('revoke execute on function %s from public', sig);
    execute format('revoke execute on function %s from anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- §13  dispatch_notify_task —— cron 唯一會呼叫的東西
-- ---------------------------------------------------------------------------
-- 形狀與 0008 的 dispatch_invoice_task() 一模一樣，只有 secret 名稱與 timeout
-- 不同。密鑰**不可以**寫進 cron.job.command（0008 §「⚠️ 密鑰不可以寫進
-- cron.job.command」整段的理由在這裡同樣成立，而且這條路徑會寄出真的信）。
--
-- ⚠️ 用到的 Vault secret：
--     notify_tasks_endpoint_url   ← 這一期新增，要手動建，見檔頭 §0.8
--     tasks_secret                ← 沿用 0008 建好的那一筆，**不要重建**
--
-- timeout 給 55 秒（比 0008 的 25 秒長）：一輪要做四件事（notify backlog →
-- 提醒信 → flush outbox → purge），其中 flush 每封信都要往返 Resend 一次。
-- 逾時只代表我們不等答案了，端點那邊照樣跑完，但會在 net._http_response 留下
-- 一筆看起來像失敗的紀錄，所以寧可等久一點。
create or replace function public.dispatch_notify_task()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
  v_req_id bigint;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name = 'notify_tasks_endpoint_url';

  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'tasks_secret';

  -- 缺任何一個都不要「送一個打不到的請求」或「安靜什麼都不做」。後者會讓排程
  -- 看起來一直是綠的，而一封信都沒出去。
  if v_url is null or v_secret is null then
    raise exception
      'MISSING_VAULT_SECRET: 需要 vault secret notify_tasks_endpoint_url 與 tasks_secret 才能派發寄信請求（見 0022_email_outbox_notify.sql 檔頭 §0.8）';
  end if;

  select net.http_post(
           url                  := v_url || '?k=' || v_secret,
           body                 := '{}'::jsonb,
           headers              := '{"content-type": "application/json"}'::jsonb,
           timeout_milliseconds := 55000
         )
    into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.dispatch_notify_task() is
  'Fires one POST at /api/tasks/notify so queued mail actually goes out. URL and secret come from Supabase Vault, never from cron.job.command. Returns the pg_net request id — look it up in net._http_response to see whether the endpoint actually answered.';

-- SECURITY DEFINER 而且會對外送出請求（而那個請求會寄出真的信）——
-- 絕對不可以從瀏覽器的金鑰打得到。呼叫它的只有 cron（以 postgres 身分執行），
-- 所以 service_role 也不需要。
revoke execute on function public.dispatch_notify_task() from public;
revoke execute on function public.dispatch_notify_task() from anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
-- §14  排程
-- ---------------------------------------------------------------------------
-- `cron.schedule(name, schedule, command)` 以 name 為鍵做 upsert，所以重跑這支
-- migration 不會產生第二個 job。放在 commit 之後是因為 cron.schedule 在某些版本
-- 會自己開交易，包進 begin/commit 裡容易踩到 "cannot run inside a transaction
-- block"（0008 §排程 的原話）。
--
-- 分鐘數的計算見檔頭 §0.7：6,16,26,36,46,56 與 `*/5`（expire）以及 `3-53/10`
-- （invoice）都不相交，三支排程永遠不會在同一個 tick 觸發。
--
-- ⚠️ 本機測試庫沒有 pg_cron / pg_net / vault，所以這一段用 to_regproc 判斷後才跑
--    （同 0020 §3 對 expire-unpaid-orders 的處理）。缺 pg_cron 只會印 warning，
--    不會讓 migration 失敗 —— 否則本機就套不上這一支，而本機正是併發測試的地方。
do $$
begin
  if to_regproc('cron.schedule(text,text,text)') is null then
    raise warning '[0022] 這個資料庫沒有 pg_cron，跳過 dispatch-notify-task 的排程（本機測試庫是正常的）';
    return;
  end if;
  perform cron.schedule(
    'dispatch-notify-task',
    '6-56/10 * * * *',
    $cron$select public.dispatch_notify_task()$cron$
  );
end $$;
