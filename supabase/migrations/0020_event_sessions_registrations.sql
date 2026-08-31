-- 0020_event_sessions_registrations.sql —— 名額搬到場次，並且開始收「誰要來」
--
-- 前一個 migration：0019_vendors_pii_portal.sql。既有 0001–0019 一律不動
-- （0009／0011／0016／0018／0019 自己的檔頭也都是這樣宣告的）；要改行為就在這裡
-- `create or replace` / `alter table`。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0  這一期在補的洞
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 這個站從 0004 起就賣得動 event / journey：`products.capacity` 有名額、
-- `reserve_product_seat()` 用 FOR UPDATE 真佔位，併發是對的。缺的是另外兩件事：
--
--   1. **沒有場次。** 一件商品只有一個名額數字，所以「同一場活動開兩個梯次」在
--      資料庫裡表達不出來，日期只能寫在 description 裡當自由文字。
--   2. **沒有參加者。** 訂單只有訂購人一個人。qty=3 的意思是「這個人買了 3 個位子」，
--      現場點名的時候另外兩位是誰，資料庫裡沒有答案。
--
-- 這一支把名額的單一真相搬到 `public.event_sessions`，並且讓「佔了 N 個位子」與
-- 「有 N 位參加者」變成**同一句 SQL 的兩個面向**。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §1  為什麼 products.capacity / seats_taken 保留不 drop
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 這個問題 0011 §11 已經解過一次：庫存原本在 `products.stock`，接進銷存的時候
-- **沒有做「兩邊同步」**，而是用 trigger 禁止有連結的商品持有 `products.stock`。
-- 名額照抄那個手法，差別只在名額的規則是全稱的（**所有**商品的名額都搬走了，
-- 不是只有某些），所以一條 CHECK 就夠，不需要 trigger。
--
--     constraint products_capacity_moved_to_sessions
--       check (capacity is null and seats_taken = 0)
--
-- **欄位保留不 drop**，理由與 0011 相同：`PRODUCT_COLUMNS`（src/server/repos/orders.ts）、
-- `COLUMNS`（src/lib/shop.ts）、`COLUMNS`（src/server/repos/products.ts）三個字串
-- 各自寫死了 `capacity, seats_taken`。程式碼會先上線、migration 後套用，中間那段
-- 時間**還在跑舊 bundle 的分頁**如果撞到被 drop 掉的欄位，PostgREST 回的是 400，
-- 整頁掛掉。留著並強制為 null，漏改的讀取路徑拿到的是 `null` 而不是舊值 ——
-- 失敗時比較安全的那一邊。
--
-- 附帶好處：新 CHECK 讓 `reserve_product_seat()`（0004）**自我失效** —— 它讀到
-- `capacity is null` 就 raise NOT_BOOKABLE。所以就算漏了一條呼叫路徑，結果是
-- 報名失敗，不是超賣。那支函式要等 Phase 5 才 drop（到那時它已無呼叫者）。
--
-- ⚠️ 這一期**刻意不加** `event_sessions.seats_offered`（候補要用的那個計數器）。
--    教訓就在同一個 repo 裡：`events.registration_type` 與 `events.payment_enabled`
--    從 0001 就存在，註解自承 "not read by any route yet"，五期之後仍然沒有任何
--    路由讀它 —— 而後台表單一直選得到「站內報名」，選了也不會發生任何事。
--    **欄位要跟讀它的程式碼同一期出。** 候補是 Phase 4 的事。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §2  為什麼「佔位」與「寫參加者」必須是同一句 SQL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 要成立的不變量是：`order_items.quantity = N  ⇒  N 列 event_registrations`。
-- 這是一條**跨列**的約束，第一直覺是 deferred constraint trigger（在交易結束時
-- 才檢查）。
--
-- ⚠️ **在這個架構下 deferred constraint trigger 不可能成立，不要再試一次。**
--    這個站沒有「一個交易包住整個結帳」這種東西：PostgREST 一個 HTTP 請求就是
--    一個交易（src/server/repos/orders.ts 檔頭把整串步驟的順序都是照這件事排的）。
--    step 3 insert order_items 的那一次 commit，registrations 還是 0 列 —— deferred
--    檢查會在那一刻當場炸掉，而那時候連 session_id 都還沒輪到要用。
--
-- 正解是把兩件事變成同一句 SQL：`public.reserve_session_seat()`（§7）。它的七步
-- 順序是固定的，而且每一步都擋掉一種具體的錯：
--
--   ① 驗 jsonb_array_length(participants) = quantity   →  PARTICIPANT_COUNT_MISMATCH
--   ② 依 id 排序鎖住這張訂單會碰到的所有場次，再鎖目標場次
--                                                      →  併發序列化（同 0004）
--   ③ 驗場次的商品 = order_item 的商品，且 order_item 屬於這張訂單
--                                                      →  SESSION_PRODUCT_MISMATCH
--   ④ 場次 status = 'open'                             →  SESSION_NOT_OPEN
--   ⑤ seats_taken + q > capacity                       →  NO_SEATS_LEFT
--   ⑥ seats_taken += q
--   ⑦ insert … from jsonb_array_elements(participants) with ordinality
--
-- ⚠️ 第 ② 步的鎖是 **for no key update**，不是 for update。這不是風格問題，是併發
--    測試實際打出來的死鎖：
--
--      order_items.session_id 的外鍵會在 insert 的時候對被參照的 event_sessions
--      那一列取一個 **FOR KEY SHARE** 列鎖。兩個交易同時 insert，兩個都拿得到
--      （KEY SHARE 是共享的）；接著兩個都想升級成 FOR UPDATE，於是各自等對方放掉
--      KEY SHARE —— 標準的鎖升級死鎖。實測 20 個併發請求，19 個全部死鎖，一個
--      NO_SEATS_LEFT 都沒有。
--
--      FOR NO KEY UPDATE 與 FOR KEY SHARE **不衝突**（它只保證沒人改鍵欄位），
--      而它彼此之間仍然衝突 —— 也就是說兩個併發的報名照樣會序列化，超賣照樣擋得住，
--      只是不再需要升級。seats_taken 不是鍵欄位，所以這正是它該用的鎖。
--
-- ⚠️ 第 ② 步先鎖「這張訂單會碰到的所有場次」再鎖目標，理由與 0011 讓
--    reserve_inventory_stock 自己 `order by ip.id for update` 一樣：**不要求呼叫端
--    記得排序**。一張訂單報名兩個梯次時，呼叫端如果照購物車的順序一個一個呼叫，
--    兩張順序相反的訂單就會 ABBA 死鎖。src/server/repos/orders.ts 確實有排序，
--    但那是「它記得」而不是「它做不到別的」—— 排序寫在函式裡，未來任何一條新的
--    呼叫路徑都不必重新推導一次。
--
-- 「已佔 N 個位子」與「有 N 位參加者」是同一次寫入的兩個面向，**不存在對不上的
-- 中間狀態**。
--
-- ⚠️ 第 ③ 步不可省。它擋的是「付 A 商品的錢、訂 B 場次的位子」—— 在加了
--    sessionId 這個由瀏覽器指定的欄位之後**新開的攻擊面**。0011 之前的結帳沒有
--    這個問題，因為那時候瀏覽器只送得出 (product_id, quantity)。
--
-- zod 那一側（src/lib/checkout.ts）也驗 participants.length === quantity，但那是
-- 為了讓客人送出前就在欄位旁邊看到錯誤訊息，**不是保證**。分工寫在 checkout.ts 的
-- 註解裡。
--
-- 回滾是 `public.release_session_seat(p_order_item_id)`：`DELETE … RETURNING`
-- 本身就是冪等 claim（第二次拿不到列就扣 0），與 0011 的
-- `commit_inventory_reservations()` 同一手法。它比現在 orders.ts 那個「讀 → CAS →
-- 重試三次」的 JS 迴圈嚴格更好，而且 registrations 會跟座位一起還回去。契約不變：
-- **best effort、絕不 throw**（它跑在別人的錯誤路徑上）。
--
-- ⚠️ `event_registrations.order_item_id` 是 `on delete cascade`，而 order_items 又
--    是從 orders cascade 下來的。所以 **`deleteOrder()` 之前一定要先呼叫
--    `release_session_seat()`** —— 直接刪訂單的話，registrations 會跟著消失，但
--    `event_sessions.seats_taken` 不會自己減。orders.ts 的 catch 區塊順序
--    （release → delete）就是為了這件事，不要調換。漏掉的後果是位子被算著卻沒人
--    報名 —— 與現行 releaseSeats() 的 best-effort 失敗方向一致（少賣，不是超賣）。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §3  順手補一個既有缺口：expire-unpaid-orders 的排程不在 repo 裡
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `public.expire_unpaid_orders()` 是 0006 建的，正式庫上有一個每 5 分鐘的 pg_cron
-- job 在打它 —— 但那個 `cron.schedule` 是**手動下的**，repo 裡沒有。0006:55-56 只是
-- 在註解裡「建議」這樣做，0008:143 則是**假設它已經存在**（在算 `3-53/10` 要跟
-- `*/5` 錯開的時候）。也就是說：重建一個環境，發票排程會有，過期回收不會有，
-- 而且沒有任何東西會說出這件事。
--
-- §10 把它補進 migration。`cron.schedule(name, schedule, command)` 以 name 為鍵做
-- upsert，所以正式庫重跑這一支不會產生第二個 job，也不會改變它現在的行為。
--
-- ⚠️ 那一段包在 `do $$ … $$` 裡並且先問 `to_regproc('cron.schedule(...)')`，理由是
--    這個 repo 的自檢要能把 0001–0020 整串套到**本機 PostgreSQL** 上跑真併發
--    （見 scripts/event-registration-selftest.mjs 檔頭）。本機沒有 pg_cron，沒有這
--    個判斷整支 migration 會停在最後一行。缺 pg_cron 時 `raise warning` 而不是安靜
--    跳過 —— 套用輸出裡看得到，符合這個 repo 一路在防的「綠燈但什麼都沒做」。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §4  鎖順序
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0011 §0 定下的規矩是「先 public.products，再 inv.products」。這一期多一張表，
-- 全站的順序固定成：
--
--     public.products  →  inv.products  →  public.event_sessions
--
-- 唯一會在同一個交易裡持有超過一張的地方仍然只有 `expire_unpaid_orders()`
-- （步驟 2 / 4b / 4c）。結帳雖然三張都碰，但 reserve_inventory_stock、
-- atomic_deduct_stock 與 reserve_session_seat 是 PostgREST 的三次呼叫＝三個交易，
-- 不會同時持有。
--
-- 同一個交易裡要鎖**多個場次**時（一張訂單報名兩個梯次），依 session id 排序取，
-- 與 0004 的 atomic_deduct_stock 同一條理由。**排序做在 reserve_session_seat 裡面**
-- （它會先鎖住整張訂單會碰到的所有場次），不是交給呼叫端記得 —— 見 §2 的第二個 ⚠️。
--
-- 場次的鎖一律是 `for no key update`，不是 `for update`。這一條沒有例外，理由是
-- order_items 的外鍵會取 FOR KEY SHARE，而 FOR UPDATE 與它衝突、FOR NO KEY UPDATE
-- 不衝突（§2 的第一個 ⚠️ 有實測數字）。

begin;

-- ---------------------------------------------------------------------------
-- 1. event_sessions —— 名額的新單一真相
-- ---------------------------------------------------------------------------
-- 「一場活動的一個梯次」：各自的時間、地點、名額。目前每個可報名商品只會有一列
-- （回填就是這樣建的），但資料庫從第一天就照多場次設計 —— 之後要開第二梯次只加
-- 畫面，不動這張表。
--
-- ⚠️ **刻意沒有 'full' 狀態。** 快樂手（~/.gemini/File/happyhand）有一個
--    sync_workshop_session_status() trigger 在維護它，而 full 是
--    `seats_taken >= capacity` 推導得出來的 —— 存起來就是第二個真相，而且那個
--    trigger 就是它唯一的維護者，漏一條路徑就對不上。status 只有兩個值，各自回答
--    一個推導不出來的問題：
--
--      'open'   —— 現在收得了報名
--      'closed' —— 現在收不了（還沒排好日期、額滿後手動關、活動結束）
--
--    「額滿」不需要一個狀態，它是 capacity - seats_taken = 0。
create table if not exists public.event_sessions (
  id          uuid primary key default gen_random_uuid(),

  -- ⚠️ on delete cascade：場次離開它的商品沒有意義。這一條會連鎖到下面
  --    order_items.session_id 的 on delete restrict —— 也就是說，**賣出去過的
  --    活動商品刪不掉**（cascade 想刪場次，卻被 order_items 擋住，整個 delete
  --    回滾）。那正是想要的行為：今天的後台可以刪掉一個 seats_taken=3 的活動商品，
  --    然後那三張訂單就指向一個不存在的東西。
  product_id  text not null references public.products (id) on delete cascade,

  title       jsonb not null check (public.is_localized(title)),
  location    jsonb not null check (public.is_localized(location)),

  starts_at   timestamptz not null,
  -- 結束時間是選填的：很多場次只公告開始時間。
  ends_at     timestamptz,

  -- 名額。這裡是唯一的真相 —— public.products 那兩欄被 §6 的 CHECK 強制成
  -- null / 0。
  capacity    integer not null check (capacity >= 0),
  seats_taken integer not null default 0 check (seats_taken >= 0),

  status      text not null default 'closed'
              check (status in ('open', 'closed')),

  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint event_sessions_seats_within_capacity check (seats_taken <= capacity),
  constraint event_sessions_time_order check (ends_at is null or ends_at >= starts_at)
);

comment on table public.event_sessions is
  '活動／策旅的梯次。名額（capacity / seats_taken）的唯一真相 —— public.products 那兩欄被 0020 的 CHECK 強制成 null / 0。';
comment on column public.event_sessions.status is
  '只有 open / closed。「額滿」不是狀態，它是 capacity - seats_taken = 0（推導得出來的東西不存）。';
comment on column public.event_sessions.seats_taken is
  '只由 reserve_session_seat() / release_session_seat() / expire_unpaid_orders() 維護。不要在別的地方寫它。';

create index if not exists event_sessions_product_idx
  on public.event_sessions (product_id, sort_order, starts_at);
create index if not exists event_sessions_open_idx
  on public.event_sessions (status, starts_at);

drop trigger if exists event_sessions_set_updated_at on public.event_sessions;
create trigger event_sessions_set_updated_at
  before update on public.event_sessions
  for each row execute function public.set_updated_at();

-- RLS：與 0004 的 public.products 同一個形狀，而不是 0005 的「零 policy」。
-- 理由是這張表要回答的問題（「這個梯次還有幾個位子」）**本來就是公開的** ——
-- 今天 products.capacity / products.seats_taken 就是 anon 讀得到的，這一期只是
-- 把同樣的兩個數字搬到另一張表。搬家不應該順便改變誰看得到什麼。
--
-- policy 裡的 exists(...) 是必要的第二半：沒有它，一個草稿商品的場次也會被
-- 前台看到。子查詢是以**呼叫者的身分**執行的，所以 anon 只查得到 status='active'
-- 的商品（products_select_public），草稿自然 join 不到 —— fail-closed。
alter table public.event_sessions enable row level security;
revoke all on table public.event_sessions from anon, authenticated;
grant select on table public.event_sessions to anon, authenticated;
grant all    on table public.event_sessions to service_role;

drop policy if exists event_sessions_select_public on public.event_sessions;
create policy event_sessions_select_public on public.event_sessions
  as permissive for select to anon, authenticated
  using (
    status = 'open'
    and exists (
      select 1 from public.products p
       where p.id = event_sessions.product_id
         and p.status = 'active'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. event_registrations —— 逐位參加者（這是 PII）
-- ---------------------------------------------------------------------------
-- 一列 = 一個位子 = 一個人。`order_items.quantity = N ⇒ N 列`，由
-- reserve_session_seat() 在同一句 SQL 裡保證（§2）。
--
-- ⚠️ 這張表放的是姓名與聯絡方式，處置比照 0005 的電商表而不是上面的 event_sessions：
--    **RLS 開著、零 policy、anon 與 authenticated 零 grant**。瀏覽器沒有任何一條
--    查詢打得到它，唯一的入口是 service_role（src/server/repos/event-registrations.ts）。
--
-- ⚠️ **log 紀律**：任何碰這張表的寫入，console.error 只印 `error.code` 與
--    `error.message`，**不印整包 error**。PostgREST 會把 Postgres 的
--    `DETAIL: Failing row contains (…)` 一路傳回來，整包記下去就是把姓名電話寫進
--    Vercel 的 log。scripts/event-registration-selftest.mjs 有靜態測試守著。
--
-- 保留期限：**不做自動清除**，與 orders 一致（業務紀錄，商業會計法五年）。這與
-- 0019 §9.2 對 ocr-scans 的處理不同，理由就是那支檔頭的分法 —— 「原始個資的副本」
-- 要最小化，「業務／稽核紀錄」要可追溯。簽到表屬於後者。
create table if not exists public.event_registrations (
  id            uuid primary key default gen_random_uuid(),

  -- on delete restrict：有人報名過的場次刪不掉。要刪就得先處理那些人。
  session_id    uuid   not null references public.event_sessions (id) on delete restrict,
  order_id      uuid   not null references public.orders (id)         on delete cascade,
  order_item_id bigint not null references public.order_items (id)    on delete cascade,

  -- 這一位是這個 order_item 的第幾個位子（1..quantity）。來自
  -- jsonb_array_elements(...) with ordinality，所以順序就是客人填寫的順序。
  seat_no       integer not null check (seat_no >= 1),

  name          text not null check (btrim(name) <> ''),
  email         text,
  phone         text,

  -- 「已閱讀活動注意事項」的**時間**，不是 boolean。存時間的話「什麼時候同意的」
  -- 這個問題答得出來，而 boolean 答不出來 —— 而那正是同意欄位存在的理由。
  -- 舊訂單回填出來的那幾列是 null：那些人確實沒看過這段文字，記成 true 是說謊。
  notice_ack_at timestamptz,

  created_at    timestamptz not null default now(),

  -- 現場找得到人。email 與 phone 各自可以是空的，但不能兩個都空。
  constraint event_registrations_contactable check (
    nullif(btrim(coalesce(email, '')), '') is not null
    or nullif(btrim(coalesce(phone, '')), '') is not null
  ),
  unique (order_item_id, seat_no)
);

comment on table public.event_registrations is
  '逐位參加者。一列＝一個位子＝一個人。PII：RLS 開著、零 policy、零 grant，只走 service_role。不做自動清除（業務紀錄）。';
comment on column public.event_registrations.notice_ack_at is
  '同意活動注意事項的時間，不是 boolean。null＝沒有同意紀錄（回填的舊訂單就是 null）。';

create index if not exists event_registrations_session_idx
  on public.event_registrations (session_id, created_at);
create index if not exists event_registrations_order_idx
  on public.event_registrations (order_id);
create index if not exists event_registrations_order_item_idx
  on public.event_registrations (order_item_id);

alter table public.event_registrations enable row level security;
revoke all on table public.event_registrations from anon, authenticated;
grant all  on table public.event_registrations to service_role;

-- ---------------------------------------------------------------------------
-- 3. order_items.session_id —— 這一行賣的是哪一個梯次
-- ---------------------------------------------------------------------------
-- on delete restrict：訂單明細記的是「當時賣了什麼」，那個東西不可以憑空消失。
-- 與上面 event_sessions.product_id 的 cascade 合起來，效果是「賣出去過的活動商品
-- 刪不掉」（見那一段的註解）。
alter table public.order_items
  add column if not exists session_id uuid
  references public.event_sessions (id) on delete restrict;

comment on column public.order_items.session_id is
  '這一行賣的梯次。goods/book 必須是 null，event/journey 必須不是 —— 見 order_items_session_shape。';

create index if not exists order_items_session_idx
  on public.order_items (session_id);

-- ---------------------------------------------------------------------------
-- 4. 回填 —— 每個可報名商品建一列場次，名額搬過去
-- ---------------------------------------------------------------------------
-- 順序是有意義的，而且每一步都寫成可重跑的（`where not exists` / `is null`），
-- 所以整支 migration 套第二次是零效果而不是零錯誤外加一堆重複資料。
--
-- ⚠️ 舊約束要先拆掉才backfill得動：products_capacity_shape 要求 event/journey
--    的 capacity **不可以是 null**，而第 4.4 步正要把它清成 null。

-- 4.1 拆掉 0004 的兩條舊 CHECK
alter table public.products drop constraint if exists products_capacity_shape;
alter table public.products drop constraint if exists products_seats_within_capacity;

-- 4.2 每個 event/journey 商品建一列場次
--
-- ⚠️ starts_at 沒有真值可以搬 —— 舊資料的日期是 description 裡的自由文字，沒辦法
--    可靠地 parse。所以用 now() 佔位，並且場次一律 **status='closed'**：先報不了名，
--    後台把日期補完再開。fail-closed，而不是讓一個日期是「套用 migration 的那一刻」
--    的場次直接對外開放。
insert into public.event_sessions
  (product_id, title, location, starts_at, capacity, seats_taken, status, sort_order)
select p.id,
       jsonb_build_object('zh', '第一梯次', 'en', 'Session 1', 'ja', '第 1 回'),
       jsonb_build_object('zh', '地點待補', 'en', 'To be announced', 'ja', '未定'),
       now(),
       coalesce(p.capacity, 0),
       coalesce(p.seats_taken, 0),
       'closed',
       0
  from public.products p
 where p.product_type in ('event', 'journey')
   and not exists (select 1 from public.event_sessions s where s.product_id = p.id);

-- 4.3 既有的 event/journey 訂單明細指向那一列場次
--
-- 用子查詢挑「最早建立的那一列」而不是直接 join：join 在「一個商品已經有兩列場次」
-- 的情況下會產生笛卡兒積，而那正是重跑這支 migration 之後可能出現的狀況。
update public.order_items oi
   set session_id = (
         select s.id
           from public.event_sessions s
          where s.product_id = oi.product_id
          order by s.sort_order, s.created_at, s.id
          limit 1
       )
 where oi.product_type in ('event', 'journey')
   and oi.session_id is null
   and oi.product_id is not null
   and exists (select 1 from public.event_sessions s where s.product_id = oi.product_id);

-- 4.4 既有訂單補第一位參加者
--
-- ⚠️ 只補**一位**，就算 quantity = 3 也一樣。舊資料裡只有訂購人一個人的姓名電話，
--    捏造另外兩位是說謊。所以「quantity = N ⇒ N 列」這條不變量只從 0020 之後成立，
--    回填出來的舊列就是對不上 —— 這件事寫在這裡，不要之後有人拿它當 bug 修。
--    名單頁（Phase 2）要據此顯示「另有 N-1 位未登錄姓名」。
insert into public.event_registrations
  (session_id, order_id, order_item_id, seat_no, name, email, phone)
select oi.session_id,
       oi.order_id,
       oi.id,
       1,
       coalesce(nullif(btrim(o.customer_name), ''), '（未留姓名）'),
       nullif(btrim(o.customer_email), ''),
       nullif(btrim(o.customer_phone), '')
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
 where oi.product_type in ('event', 'journey')
   and oi.session_id is not null
   and not exists (
         select 1 from public.event_registrations r where r.order_item_id = oi.id
       );

-- 4.5 名額從 products 搬走
update public.products
   set capacity = null,
       seats_taken = 0
 where capacity is not null
    or seats_taken <> 0;

-- ---------------------------------------------------------------------------
-- 5. order_items 的形狀 CHECK
-- ---------------------------------------------------------------------------
-- order_items 本來就有 denormalized 的 product_type（0005:131），所以這條規則
-- **在同一列裡就答得出來** —— 用得起 CHECK，不需要 trigger。這是這張表把
-- product_type 存下來換到的第二個好處（第一個是商品被刪掉之後訂單仍看得出賣了什麼）。
--
-- 兩個方向都要：goods/book 帶了 session_id 是資料錯亂，event/journey 沒帶
-- session_id 則是「賣了一個位子但不知道是哪一場」。
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'order_items_session_shape'
  ) then
    alter table public.order_items
      add constraint order_items_session_shape check (
        (product_type in ('event', 'journey') and session_id is not null)
        or (product_type in ('goods', 'book') and session_id is null)
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. products：名額欄位強制淨空
-- ---------------------------------------------------------------------------
-- 見 §1。一條 CHECK 取代 0004 的兩條，而且它讓 reserve_product_seat() 自我失效。
alter table public.products drop constraint if exists products_capacity_moved_to_sessions;
alter table public.products
  add constraint products_capacity_moved_to_sessions
  check (capacity is null and seats_taken = 0);

comment on column public.products.capacity is
  '0020 起一律 null —— 名額搬到 public.event_sessions。欄位保留是為了讓還在跑舊 bundle 的分頁拿到 null 而不是 PostgREST 400。';
comment on column public.products.seats_taken is
  '0020 起一律 0 —— 名額搬到 public.event_sessions.seats_taken。';

-- ---------------------------------------------------------------------------
-- 7. reserve_session_seat —— 佔位與寫參加者是同一句 SQL
-- ---------------------------------------------------------------------------
-- 七步順序見 §2。回傳寫進去的 registrations 列數（= p_quantity）。
--
-- 每一種失敗都用**自己的錯誤字串**，不共用一個 'BAD_REQUEST'：呼叫端
-- （src/server/repos/orders.ts）只把 NO_SEATS_LEFT 對應成客人看得懂的「名額已滿」，
-- 其餘一律變成一般性失敗 —— 因為其餘那幾種只可能來自被改過的 payload 或程式 bug，
-- 對客人講細節沒有意義，對 log 講細節才有。
create or replace function public.reserve_session_seat(
  p_order_id      uuid,
  p_order_item_id bigint,
  p_session_id    uuid,
  p_quantity      integer,
  p_participants  jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity        integer;
  v_taken           integer;
  v_status          text;
  v_session_product text;
  v_item_product    text;
  v_item_order      uuid;
  v_inserted        integer;
begin
  -- ---- ① 數量與參加者筆數必須相等 ---------------------------------------
  -- 放在最前面而不是最後面：它一個字都還沒寫，所以「數量對不上」這件事永遠不會
  -- 留下半套資料。自檢有一條專門驗這個（seats_taken 完全不變、registrations 0 列）。
  if p_order_id is null or p_order_item_id is null or p_session_id is null then
    raise exception 'MISSING_ARGUMENT' using errcode = 'check_violation';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY:%', p_quantity using errcode = 'check_violation';
  end if;
  if p_participants is null or jsonb_typeof(p_participants) <> 'array' then
    raise exception 'PARTICIPANTS_NOT_ARRAY' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_participants) <> p_quantity then
    raise exception 'PARTICIPANT_COUNT_MISMATCH:% vs %',
      jsonb_array_length(p_participants), p_quantity
      using errcode = 'check_violation';
  end if;

  -- ---- ② 鎖場次 ----------------------------------------------------------
  -- 「讀 seats_taken → 判斷夠不夠 → 寫回」是典型的 read-modify-write，兩個併發
  -- 請求都讀到「還有 1 個」就會雙雙通過。行鎖讓第二個請求必須等第一個 commit
  -- 之後才讀得到 seats_taken，於是它讀到的是新的事實。同 0004 的
  -- atomic_deduct_stock / reserve_product_seat。
  --
  -- 先把**這張訂單會碰到的所有場次**依 id 排序鎖起來，再鎖目標那一列。見檔頭 §2
  -- 的兩個 ⚠️：排序是為了不要求呼叫端記得排序，for no key update 是為了不要與
  -- order_items 外鍵取的 FOR KEY SHARE 互相升級成死鎖。
  perform 1
    from public.event_sessions s
   where s.id in (
           select oi.session_id
             from public.order_items oi
            where oi.order_id = p_order_id
              and oi.session_id is not null
         )
   order by s.id
     for no key update;

  select s.capacity, s.seats_taken, s.status, s.product_id
    into v_capacity, v_taken, v_status, v_session_product
    from public.event_sessions s
   where s.id = p_session_id
     for no key update;
  if not found then
    raise exception 'SESSION_NOT_FOUND:%', p_session_id using errcode = 'check_violation';
  end if;

  -- ---- ③ 這個位子真的屬於這張訂單、這件商品 ------------------------------
  -- ⚠️ 不可省。session_id 是**瀏覽器送上來的**，所以「付 A 商品的錢、訂 B 場次的
  --    位子」在加了這個欄位之後才變成可能。這一步就是那個新攻擊面的門。
  select oi.product_id, oi.order_id
    into v_item_product, v_item_order
    from public.order_items oi
   where oi.id = p_order_item_id;
  if not found then
    raise exception 'ORDER_ITEM_NOT_FOUND:%', p_order_item_id using errcode = 'check_violation';
  end if;
  if v_item_order is distinct from p_order_id then
    raise exception 'ORDER_ITEM_ORDER_MISMATCH:%', p_order_item_id using errcode = 'check_violation';
  end if;
  if v_item_product is distinct from v_session_product then
    raise exception 'SESSION_PRODUCT_MISMATCH:%', p_session_id using errcode = 'check_violation';
  end if;

  -- ---- ④ 場次要開著 ------------------------------------------------------
  if v_status <> 'open' then
    raise exception 'SESSION_NOT_OPEN:%', p_session_id using errcode = 'check_violation';
  end if;

  -- ---- ⑤ 超額 -----------------------------------------------------------
  -- 沿用 0004 就在用的字串 NO_SEATS_LEFT，所以 src/lib/checkout.ts 的錯誤碼
  -- （no_seats_left）與那三語文案一個字都不用動。
  if v_taken + p_quantity > v_capacity then
    raise exception 'NO_SEATS_LEFT:%', p_session_id using errcode = 'check_violation';
  end if;

  -- ---- ⑥ 佔位 -----------------------------------------------------------
  -- 相對更新（+= q）而不是寫回讀到的值：後者就是超賣。行鎖已經拿在手上，所以
  -- 這一句與 ⑤ 之間沒有別人插得進來。
  update public.event_sessions
     set seats_taken = seats_taken + p_quantity
   where id = p_session_id;

  -- ---- ⑦ 寫參加者 --------------------------------------------------------
  -- with ordinality 給的就是 seat_no：客人在表單上填的順序 = 名單上的順序。
  -- 空字串一律轉 null，讓「沒填」與「填了空白」在名單頁上長得一樣。
  insert into public.event_registrations
    (session_id, order_id, order_item_id, seat_no, name, email, phone, notice_ack_at)
  select p_session_id,
         p_order_id,
         p_order_item_id,
         e.ord::integer,
         btrim(coalesce(e.value ->> 'name', '')),
         nullif(btrim(coalesce(e.value ->> 'email', '')), ''),
         nullif(btrim(coalesce(e.value ->> 'phone', '')), ''),
         case when coalesce(e.value ->> 'noticeAck', '') in ('true', 't', '1')
              then now() else null end
    from jsonb_array_elements(p_participants) with ordinality as e(value, ord);

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function public.reserve_session_seat(uuid, bigint, uuid, integer, jsonb) is
  '佔位與寫參加者的同一句 SQL。七步固定順序，第 ③ 步擋「付 A 商品的錢、訂 B 場次的位子」。回傳寫入的 registrations 列數。';

-- ---------------------------------------------------------------------------
-- 8. release_session_seat —— 回滾（冪等、絕不 throw）
-- ---------------------------------------------------------------------------
-- 契約與 orders.ts 現行的 releaseSeats() 一樣：它跑在**別人的錯誤路徑上**，所以
-- 不可以自己拋錯把原本的錯誤蓋掉。找不到、參數是 null、場次已經不在了 —— 一律
-- 回 0，不 raise。
--
-- `DELETE … RETURNING` 本身就是冪等 claim（同 0011 的
-- commit_inventory_reservations）：第一次呼叫拿到 q 列並扣 q，第二次拿到 0 列、
-- 扣 0。不需要任何「有沒有已經還過」的旗標欄位。
create or replace function public.release_session_seat(p_order_item_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session uuid;
  v_freed   integer := 0;
begin
  if p_order_item_id is null then
    return 0;
  end if;

  select r.session_id into v_session
    from public.event_registrations r
   where r.order_item_id = p_order_item_id
   limit 1;

  if v_session is null then
    return 0;
  end if;

  -- 先鎖場次再刪，與 reserve 用同一條規矩（包括 for no key update，理由見檔頭）。
  -- 兩個併發的 release 打同一個 order_item 時，第二個會在這裡等，等到的時候
  -- DELETE 已經沒有列可以拿了。
  perform 1 from public.event_sessions s where s.id = v_session for no key update;

  with gone as (
    delete from public.event_registrations r
     where r.order_item_id = p_order_item_id
    returning 1
  )
  select count(*)::integer into v_freed from gone;

  if v_freed > 0 then
    update public.event_sessions s
       set seats_taken = greatest(0, s.seats_taken - v_freed)
     where s.id = v_session;
  end if;

  return v_freed;
exception
  when others then
    -- best effort。回 0 而不是把錯誤往上丟 —— 上面那層正在報告另一個錯誤。
    -- 最壞的情況是位子被算著卻沒人報名（少賣），不是同一個位子賣兩次。
    return 0;
end;
$$;

comment on function public.release_session_seat(bigint) is
  '回收一個 order_item 佔住的位子與參加者。DELETE…RETURNING 當冪等 claim，第二次回 0。絕不 throw（跑在別人的錯誤路徑上）。';

-- ---------------------------------------------------------------------------
-- 9. expire_unpaid_orders —— 加一句「放掉場次名額」
-- ---------------------------------------------------------------------------
-- ⚠️ create or replace 覆寫 0011 的同名函式（它自己覆寫的是 0006）。0006 與 0011
--    的檔案一個字都不改；**回傳的 TABLE 形狀必須逐字相同**：
--
--        expired_id uuid, expired_order_no text, restored_stock integer, restored_seats integer
--
--    PostgreSQL 不允許 CREATE OR REPLACE 改 RETURNS TABLE 的形狀，要改就得先
--    DROP FUNCTION —— 而 drop 會斷掉正在跑的 pg_cron job（§3 說的那一支），
--    在 drop 與 create 之間的每一次觸發都會失敗。scripts/event-registration-selftest.mjs
--    有一條把 0011 與 0020 的這個區塊抽出來、正規化空白後**比對相等**。
--
-- 相對 0011 的差異只有新增的第 4c 步。第 4 步（products.seats_taken 還原）逐字
-- 保留：§6 的 CHECK 之後它是必然的 no-op，但留著才看得出「這裡本來做過這件事」，
-- 而且 Phase 5 清死碼之前它不花任何代價。
create or replace function public.expire_unpaid_orders(
  p_older_than interval default '30 minutes',
  p_limit      integer  default 200
)
returns table (
  expired_id       uuid,
  expired_order_no text,
  restored_stock   integer,
  restored_seats   integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  if p_limit is null or p_limit <= 0 then
    raise exception 'INVALID_LIMIT:%', p_limit;
  end if;
  if p_older_than is null or p_older_than < interval '0' then
    raise exception 'INVALID_INTERVAL:%', p_older_than;
  end if;

  -- ---- 1. claim the candidates ------------------------------------------
  select array_agg(c.id)
    into v_ids
    from (
      select o.id
        from public.orders o
       where o.status = 'pending'
         and o.payment_status <> 'paid'
         and o.paid_at is null
         and o.created_at < now() - p_older_than
       order by o.created_at
       limit p_limit
         for update skip locked
    ) c;

  if v_ids is null or cardinality(v_ids) = 0 then
    return;
  end if;

  -- ---- 2. lock the products, in id order --------------------------------
  perform 1
    from public.products p
   where p.id in (
           select oi.product_id
             from public.order_items oi
            where oi.order_id = any(v_ids)
              and oi.product_id is not null
         )
   order by p.id
     for update;

  -- ---- 3. give the goods back -------------------------------------------
  update public.products p
     set stock = p.stock + agg.qty
    from (
      select oi.product_id as pid, sum(oi.quantity)::integer as qty
        from public.order_items oi
       where oi.order_id = any(v_ids)
         and oi.product_id is not null
         and oi.product_type in ('goods', 'book')
       group by oi.product_id
    ) agg
   where p.id = agg.pid
     and p.stock is not null;

  -- ---- 4. give the seats back -------------------------------------------
  -- 0020 之後這一句是必然的 no-op（products.seats_taken 被 CHECK 綁成 0），
  -- 逐字保留 —— 見本節開頭。真正還名額的是 4c。
  update public.products p
     set seats_taken = greatest(0, p.seats_taken - agg.qty)
    from (
      select oi.product_id as pid, sum(oi.quantity)::integer as qty
        from public.order_items oi
       where oi.order_id = any(v_ids)
         and oi.product_id is not null
         and oi.product_type in ('event', 'journey')
       group by oi.product_id
    ) agg
   where p.id = agg.pid;

  -- ---- 4b. 放掉進銷存的保留（0011 新增）---------------------------------
  perform 1
    from inv.products ip
   where ip.id in (
           select r.inv_product_id
             from public.stock_reservations r
            where r.order_id = any(v_ids)
         )
   order by ip.id
     for update;

  delete from public.stock_reservations r
   where r.order_id = any(v_ids);

  -- ---- 4c. 放掉場次名額與參加者（0020 新增）-----------------------------
  -- 刪 registrations 與扣 seats_taken 在同一句裡（data-modifying CTE），所以
  -- 不存在「人刪掉了、位子還算著」的中間狀態 —— 與 reserve 是同一句的道理相同。
  --
  -- 鎖順序 public.products → inv.products → event_sessions，見 §4。
  perform 1
    from public.event_sessions s
   where s.id in (
           select r.session_id
             from public.event_registrations r
            where r.order_id = any(v_ids)
         )
   order by s.id
     for no key update;

  with freed as (
    delete from public.event_registrations r
     where r.order_id = any(v_ids)
    returning r.session_id
  ), agg as (
    select session_id, count(*)::integer as n from freed group by session_id
  )
  update public.event_sessions s
     set seats_taken = greatest(0, s.seats_taken - agg.n)
    from agg
   where s.id = agg.session_id;

  -- ---- 5. cancel the orders ---------------------------------------------
  update public.orders o
     set status         = 'cancelled',
         payment_status = case
                            when o.payment_status = 'pending' then 'failed'
                            else o.payment_status
                          end,
         cancelled_at   = now(),
         failed_reason  = 'unpaid_timeout'
   where o.id = any(v_ids)
     and o.status = 'pending'
     and o.payment_status <> 'paid'
     and o.paid_at is null;

  -- ---- 6. close out the payment attempts ---------------------------------
  update public.payments pay
     set status = 'failed'
   where pay.order_id = any(v_ids)
     and pay.status = 'pending';

  -- ---- 7. report what happened -------------------------------------------
  return query
    select o.id,
           o.order_no,
           coalesce((
             select sum(oi.quantity)::integer
               from public.order_items oi
               join public.products pr on pr.id = oi.product_id
              where oi.order_id = o.id
                and oi.product_type in ('goods', 'book')
                and pr.stock is not null
           ), 0),
           coalesce((
             select sum(oi.quantity)::integer
               from public.order_items oi
               join public.products pr on pr.id = oi.product_id
              where oi.order_id = o.id
                and oi.product_type in ('event', 'journey')
           ), 0)
      from public.orders o
     where o.id = any(v_ids)
       and o.status = 'cancelled'
     order by o.order_no;
end;
$$;

comment on function public.expire_unpaid_orders(interval, integer) is
  '0011 版本 + 第 4c 步：一併放掉 event_sessions 的名額與 event_registrations。RETURNS TABLE 形狀與 0006／0011 逐字相同。';

-- ---------------------------------------------------------------------------
-- 10. product_availability —— 活動那一支改讀場次
-- ---------------------------------------------------------------------------
-- ⚠️ 這一段**不是可選的**。0011 的版本寫的是
--
--        when p.product_type in ('event','journey') and p.capacity is not null then …
--
--    §6 之後 capacity 一律是 null，那個分支永遠不會成立，於是活動商品會一路掉到
--    最後的 `else 10` —— 前台會顯示「還很多」。改成 fail-open 是這一期最容易踩到
--    的一個坑，所以這裡把整個 view 重寫一次。
--
-- 商品層級的可售量取**各個 open 場次的最大值**，不是總和：客人一次只報一個梯次，
-- 所以「這件商品還買得到嗎」的答案是「有沒有任何一個梯次還有位子」。真正決定
-- 「這個梯次還剩幾個」的是 src/lib/shop.ts 的 remainingForSession()，它直接讀
-- event_sessions。
--
-- 其餘三個分支（有進銷存連結 / 純型錄庫存 / 不受庫存管）逐字保留 0011 的寫法。
create or replace view public.product_availability
with (security_invoker = false) as
select
  p.id as product_id,
  v.units > 0 as in_stock,
  least(v.units, 10)::integer as available_capped
from public.products p
left join public.product_inventory_links l on l.product_id = p.id
left join inv.products src on src.id = l.inv_product_id
left join inv.products tgt
       on tgt.id = coalesce(src.base_product_id, src.id)
cross join lateral (
  select case
    -- 有連結：可售量 = 實體庫存 − 保留量，再換算回「幾個型錄商品」
    when l.product_id is not null then
      greatest(0,
        (coalesce(tgt.stock_quantity, 0)
          - coalesce((select sum(r.quantity)::integer
                        from public.stock_reservations r
                       where r.inv_product_id = tgt.id), 0))
        / greatest(
            l.units_per_sale
              * case when src.base_product_id is not null
                     then coalesce(src.pack_size, 1) else 1 end,
            1)
      )
    -- 活動／策旅：名額在 event_sessions。沒有任何 open 場次 = 0（報不了名），
    -- 不是 else 那一支的「還很多」—— fail-closed。
    when p.product_type in ('event', 'journey') then
      coalesce((
        select max(greatest(0, s.capacity - s.seats_taken))
          from public.event_sessions s
         where s.product_id = p.id
           and s.status = 'open'
      ), 0)
    -- 純型錄商品：沿用 public.products.stock（0004 的既有路徑，行為不變）
    when p.stock is not null then
      greatest(0, p.stock)
    -- 不受庫存管：回報上限值，也就是「還很多」
    else 10
  end as units
) v
where p.status = 'active';

comment on view public.product_availability is
  '前台可售量。只三個欄位，上限 10。活動／策旅讀 event_sessions 的 open 場次最大剩餘（0020 改），有連結的讀 inv，其餘沿用 public.products.stock。';

grant select on public.product_availability to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. 權限
-- ---------------------------------------------------------------------------
-- 與 0004 / 0006 / 0007 / 0011 相同處理：PostgreSQL 建立函式時預設把 EXECUTE 授給
-- PUBLIC，所以「從 public revoke」才是真正生效的那一半，anon/authenticated 是保險。
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.reserve_session_seat(uuid, bigint, uuid, integer, jsonb)',
    'public.release_session_seat(bigint)'
  ]
  loop
    execute format('revoke execute on function %s from public', sig);
    execute format('revoke execute on function %s from anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end loop;
end $$;

-- 覆寫掉的那一支也重跑一次，避免 create or replace 之後權限漂移。
revoke execute on function public.expire_unpaid_orders(interval, integer) from public;
revoke execute on function public.expire_unpaid_orders(interval, integer) from anon, authenticated;
grant  execute on function public.expire_unpaid_orders(interval, integer) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- 12. 排程：把手動下的 expire-unpaid-orders 補進 repo
-- ---------------------------------------------------------------------------
-- 見 §3。cron.schedule(name, schedule, command) 以 name 為鍵做 upsert，所以正式庫
-- 重跑不會產生第二個 job，也不會改變它現在的行為（`*/5`、呼叫同一支函式）。
--
-- 放在 commit 之後，理由同 0008：cron.schedule 在某些版本會自己開交易，包進
-- begin/commit 裡容易踩到 "cannot run inside a transaction block"。
--
-- `*/5` 是正式庫上那個 job 現在就在用的排程，這裡是把它寫下來而不是改它。
-- 與 0008 的 `3-53/10`（分鐘 3,13,23,33,43,53）永遠不會在同一個 tick 觸發 ——
-- 5 的倍數與那六個數字不相交，0008:143 的註解就是靠這件事成立的。
--
-- ⚠️ 沒有 pg_cron 的資料庫（本機測試庫）印 warning 而不是失敗，見 §3。
do $$
begin
  if to_regproc('cron.schedule(text, text, text)') is null then
    raise warning 'PG_CRON_NOT_INSTALLED —— 略過 expire-unpaid-orders 排程。正式庫上這一段必須執行，套用後請用 `select jobname, schedule from cron.job;` 確認有 expire-unpaid-orders 與 dispatch-invoice-task 兩筆。';
  else
    perform cron.schedule(
      'expire-unpaid-orders',
      '*/5 * * * *',
      'select public.expire_unpaid_orders()'
    );
  end if;
end $$;
