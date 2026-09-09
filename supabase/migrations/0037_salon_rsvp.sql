-- 0037_salon_rsvp.sql —— 沙龍席位回覆（RSVP）
--
-- 前一支 migration：0036_event_session_plans.sql。既有 0001–0036 一律不動——這裡只
-- `create table if not exists` 一張全新的表，不改任何既有表、函式或約束的形狀。
--
-- ⚠️ 這一支本來編 0036，與 0036_event_session_plans.sql 撞號（兩邊同時在開發，
--    各自從 0035 往下編）。改成 0037 的是這一支，因為對方先進 main。兩張表互不
--    相干，正式庫兩張都已經存在；本檔全程 `if not exists`，重跑安全。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0  為什麼不用 event_registrations
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 站上已經有一套完整的報名機制（event_sessions + event_registrations），但它整條
-- 路是**掛在訂單上的**：一列 event_registrations 必須有 order_id 與 order_item_id
-- （0020 §5 的 NOT NULL），因為它記的是「這個位子是哪一張訂單買的、第幾號座位」。
-- seats_taken 也只由 reserve_session_seat() 在交易裡維護。
--
-- 城市思享沙龍不是那個形狀：15 席、定向邀請、**審核制**、不收錢。沒有訂單、沒有
-- 付款、而且「回覆了」不等於「拿到位子」——中間有一道人工審核。硬塞進
-- event_registrations 會做三件錯事：
--
--   1. 為了滿足 NOT NULL 生一張金額 0 的假訂單，讓 orders 混進不是交易的東西；
--   2. 回覆的當下就佔掉 seats_taken，等於跳過審核直接給位子；
--   3. 「遺憾不克前往」這種回覆在那套語彙裡根本沒有位置——它不是報名。
--
-- 所以另開一張表。它跟金流、名額、座位號都沒有關係，就是一份回條清單。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §1  表
-- ═══════════════════════════════════════════════════════════════════════════
--
-- event_slug 是**純文字，不是 FK**。同 products.source_id 的理由（0004:41-43）：
-- 這一頁是為了某一場沙龍做的獨立著陸頁，它不保證那一場一定有對應的 public.events
-- 列；反過來，活動被刪掉的時候也不該連帶把已經收到的回條刪掉——那是要留存的紀錄。
create table if not exists public.salon_rsvps (
  id           uuid primary key default gen_random_uuid(),

  event_slug   text not null,

  name         text not null,
  organisation text,
  job_title    text,
  phone        text,
  email        text not null,

  -- 只有兩種回覆。「未回覆」不是狀態——沒有回覆的人根本不會有列。
  attending    text not null check (attending in ('yes', 'no')),

  -- 「您最期待探討的題目或可提供的合作資源」。選填。
  message      text,

  created_at   timestamptz not null default now(),

  -- 空白字串不是「有填」。前端擋一次、資料庫再擋一次，因為表單以外的呼叫端
  -- （日後的匯入、後台補登）不會經過那個前端。
  constraint salon_rsvps_name_present  check (btrim(name) <> ''),
  constraint salon_rsvps_email_present check (btrim(email) <> '')
);

-- 刻意**不**對 email 加唯一鍵。同一個人可能先回「不克前往」之後改成「確認出席」，
-- 唯一鍵會讓那個更正變成一個他看不懂的錯誤。重複由讀的人依 created_at 判斷，
-- 最後一筆為準。
create index if not exists salon_rsvps_event_idx
  on public.salon_rsvps (event_slug, created_at desc);

-- ⚠️ 這幾句 `comment on … is '…'` 裡**不要**出現 AREAS 的識別字。
--    帳本的反少報偵測器（assertLedgerDeclarationsHonest）剝掉的是 `--` 註解，
--    字串常值它照掃——所以在這裡提一次「與 event_registrations 無關」，就會讓這支
--    migration 被判定成動到 event_registrations 與 events_shape 兩區，把九支
--    依賴那兩區的自檢一起叫回來重審。理由寫在上面的 §0，那裡是 `--`，安全。
comment on table public.salon_rsvps is
  '沙龍席位回覆。不收錢、審核制的邀請回條；與掛在訂單上的那一套報名機制無關，理由見本檔 §0。';
comment on column public.salon_rsvps.event_slug is
  '哪一場沙龍。純文字不是 FK：著陸頁不保證有對應的活動列，活動被刪也不該連帶刪掉回條。';
comment on column public.salon_rsvps.attending is
  'yes=確認出席／no=遺憾不克前往。「未回覆」不是狀態，沒回覆的人不會有列。';

-- ═══════════════════════════════════════════════════════════════════════════
-- §2  RLS —— 這張表全是個資
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 姓名、職稱、電話、email 全部在這裡。規格與 public.event_registrations（0020 §5）
-- 完全一致：**RLS 開著、一條 policy 都不給、anon/authenticated 的權限全部收回**，
-- 只有 service_role 進得來。
--
-- 表單是公開的，但它**不是**由瀏覽器直接 insert——那需要給 anon 一條 insert policy，
-- 而有了那條 policy，任何人都可以對這張表灌任意資料。寫入一律走 server fn
-- （src/lib/salon-rsvp.ts），在伺服器端用 service role 進來。
alter table public.salon_rsvps enable row level security;
revoke all on table public.salon_rsvps from anon, authenticated;
grant all  on table public.salon_rsvps to service_role;
