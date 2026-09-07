-- 0036_event_session_plans.sql —— 一個場次可以開多個價格方案（票種）
--
-- 前一支 migration：0035_admin_order_registration_cleanup.sql。既有 0001–0035
-- 一律不動——這裡只新建 `event_session_plans`、`order_items` 加兩欄、新增兩支函式
-- （`reserve_plan_units` / `release_plan_units`），並 `create or replace`
-- `release_session_seat()` 與 `expire_unpaid_orders()`（簽章與 `expire_unpaid_orders`
-- 的 `returns table` 形狀逐字不變）。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0  在補哪個洞
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 後台到 0035 為止，一場活動只有一個價格：`products.price`。`event_sessions`
-- 完全沒有價格欄位，所以同一個場次沒辦法開「早鳥價」「一般價」，也沒辦法讓一個
-- 「單位」（例如雙人房）佔用超過一個名額。直接的使用者是「2026 台東池上秋收山海
-- 旅行」（NT$21,800，`products.id = 87d6aee2-719b-463d-908b-04557733d13e`）——
-- 它現在有 0 個場次、根本還不能線上報名，而房型定價正是這一期的需求來源。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §1  數量的語意 —— 這是整個設計最容易做錯的地方
-- ═══════════════════════════════════════════════════════════════════════════
--
--   order_items.quantity   買了幾個「單位」（例：2 間雙人房），不是幾個位子
--   order_items.unit_price 方案的單價（每單位）；沒有方案時就是 products.price
--   order_items.subtotal   unit_price × quantity —— 慣例維持不變
--   佔用的座位數           quantity × plan.seats_per_unit（2 × 2 = 4 個位子）
--   participants 長度      等於座位數，不是等於 quantity
--   event_registrations    列數等於座位數，seat_no 1..座位數
--
-- 所以 `reserve_session_seat()`（0020）的簽章與內部契約完全不用改：呼叫端
-- （src/server/repos/orders.ts）傳給 `p_quantity` 的是**座位數**
-- （quantity × seats_per_unit），函式內部「p_quantity == participants 長度 ==
-- 扣掉的位子」這件事原樣成立。**沒有方案的場次**：seats_per_unit 視同 1，
-- quantity 就是座位數——0020 之後的行為一個字都不變。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §2  方案自己的名額池：`reserve_plan_units()`，鎖的順序固定在場次之後
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 檔頭 0020 §2 的兩個 ⚠️ 對這一期同樣成立，而且多一層：
--
--   · 場次鎖一律 `for no key update`、依 id 排序，理由不重複——0020 §2 的第一個
--     ⚠️ 已經有實測數字（20 併發用 `for update` 有 19 個死鎖）。
--   · **方案的鎖固定在場次之後**，同樣依 id 排序、同樣 `for no key update`。
--     `reserve_plan_units()` 自己重新鎖一次「這張訂單會碰到的所有場次」——不是
--     「沿用 reserve_session_seat() 鎖過的那批」，因為 PostgREST 一個 HTTP 請求
--     一個交易（0020 §2 already 講過這件事），兩支函式是**兩次獨立的呼叫、兩個
--     獨立的交易**，reserve_session_seat() 那次交易 commit 的當下鎖就放掉了。
--     `reserve_plan_units()` 要在自己的交易裡重新建立「場次先、方案後」這個順序，
--     這樣任何會同時碰到場次與方案兩張表的交易（這支、release_session_seat()、
--     expire_unpaid_orders()）都遵守同一個全站固定順序，才不會形成環。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §3  🔴 為什麼多了一支 `release_plan_units()`——這是原始設計沒有的、實作時
--      才發現必須加的第三支函式
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 核准的設計只點名兩支新函式：`event_session_plans` 表與 `reserve_plan_units()`。
-- 寫 `src/server/repos/orders.ts` 的呼叫順序時發現，只靠這兩支會有一個真的會
-- corrupt 資料的洞：
--
-- `createOrder()` 對「有方案的那一行」要打兩支 RPC——`reserve_plan_units()` 與
-- `reserve_session_seat()`——而 PostgREST 一個請求一個交易，這兩支是**兩個獨立
-- 的交易**。如果 A 成功、B 失敗，只有 B 失敗的那一半是乾淨的（B 沒有寫任何東西）；
-- A 成功的那一半已經真的改了資料，需要一個明確的「還回去」動作，而且**只能還
-- A 真正動過的那一份**，不能靠事後從 order_items 反推「這一行應該還多少」——
-- 因為 order_items.plan_id / quantity 在两支 RPC 都还没打之前就已经写好了
-- （它們是 insert-only 快照，見 0005），單看這一列**分不出** A 那個交易到底
-- 成功了沒有。
--
-- 如果呼叫順序是「先佔位子、後佔方案」（核准設計文字唸起來的順序），一旦方案那
-- 一步失敗，orders.ts 現有的救援機制（release_session_seat()）就會被叫去清這個
-- order_item——而 release_session_seat() 為了讓 expire_unpaid_orders() 與
-- admin_delete_order() 這些「事後回收」的呼叫端不用逐一學會方案的存在，勢必要用
-- 「這個 order_item 有 plan_id 就順手把 units_taken 扣掉 quantity」這種**從
-- order_items 反推**的寫法（§4／§5 就是這樣寫的）。但這個特定的失敗窗口裡，
-- units_taken **根本沒有被加過**（reserve_plan_units() 還沒打或打失敗了）——
-- 反推出來的「順手扣掉」會去扣到別的訂單合法持有的 units_taken，數字看起來像
-- 「少賣了」，其實是**偷了別人的名額**（silent corruption，不是單純的少算）。
--
-- 反過來，如果順序是「先佔方案、後佔位子」，同一個問題會出現在另一邊：方案那步
-- 成功、位子那步失敗時，這個 order_item 完全沒有 event_registrations 可以刪
-- （reserve_session_seat() 沒打成功），release_session_seat() 會在
-- `v_session is null` 那一步直接回 0、什麼都不做——剛剛真的加上去的 units_taken
-- 就這樣漏放了（這個方向不會偷別人的名額，但會讓方案的名額永久少一個，直到有人
-- 手動修資料）。
--
-- 兩個方向都是真的 bug，而且都不是「理論上」——只要方案在兩次呼叫之間的窄窗口裡
-- 被另一個併發訂單搶完，就會**每次**發生。修法是採用「先佔方案、後佔位子」的順序，
-- 並且在「方案佔到了、位子沒佔到」這個唯一會漏東西的窗口，由 `createOrder()`
-- **當場**呼叫這支新函式直接補救——不經過 order_items 反推，直接用「剛剛真的呼叫
-- reserve_plan_units() 用了多少 p_units」這個 TypeScript 端本來就知道的數字去扣。
-- 這樣一來：
--
--   · 這個窗口之外，任何時候呼叫 release_session_seat() 看到的 order_item，
--     它的方案保留與座位保留必定是**同時成立或同時不成立**（因為唯一會讓兩者
--     分岔的窄窗口，已經在窗口發生的當下被這支函式即時補上了）——所以 §4／§5
--     那個「從 order_items 反推」的寫法對 release_session_seat() 與
--     expire_unpaid_orders() 的所有其它呼叫端（訂單完整失敗回滾、
--     admin_delete_order()、過期回收）都是安全的。
--   · 這支函式只做一件事、鎖的東西最少（只鎖它自己要改的那一列方案，不需要鎖
--     場次——它從不去動 event_sessions，兩個資源之間也就不存在互相等待的環，
--     不需要跟著「場次先、方案後」那條規矩）、`security definer` +
--     只 grant service_role，與其餘每一支寫入函式同一套姿勢。
--
-- 呼叫端只有一處：`src/server/repos/orders.ts` 的 `createOrder()`，在
-- `reserve_plan_units()` 成功、緊接著的 `reserve_session_seat()` 卻失敗的那一刻
-- 立即呼叫，不進一般的 `reservedItemIds` / `releaseSeats()` 佇列（那個佇列只在
-- **兩步都成功**之後才會收下這個 order_item id，見 orders.ts 的註解）。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §4  `release_session_seat()`：一併回沖 units_taken
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 🔴 漏這一步的後果與 0035 修的那個雷同一個形狀：每回收一次有方案的訂單，
--    `event_session_plans.units_taken` 就永久多算一份，畫面上看不出來，只會
--    慢慢變成「明明沒人訂卻顯示方案已滿」。
--
-- 還原的量是 order_item 自己的 `quantity`（買了幾個單位），**不是**用
-- `v_freed`（這次真的刪掉幾列 registrations）除以 `seats_per_unit` 反推——
-- `release_session_seat()` 一次刪的是**整個 order_item** 的所有 registrations，
-- 所以 v_freed 在正常情況下就等於 quantity × seats_per_unit，用 quantity 更直接、
-- 也不必擔心除不盡。§3 已經說明了為什麼這裡讀到的 plan_id / quantity 永遠與真正
-- 保留的狀態一致。
--
-- 冪等性沿用 0020 的設計：整段方案回沖包在 `if v_freed > 0` 裡——DELETE…RETURNING
-- 第二次呼叫拿到 0 列，v_freed = 0，兩個回沖（座位、方案）都自然是 no-op。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §5  `expire_unpaid_orders()`：新增第 4d 步，RETURNS TABLE 形狀逐字不變
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠️ `create or replace` 不能改 `returns table` 的形狀——PostgreSQL 不允許，
--    要改就得先 `drop function`，而 drop 會斷掉正式庫上那支每 5 分鐘的
--    `pg_cron` job（0020 §3／§9 的原話）。這裡的四個回傳欄位
--    （`expired_id / expired_order_no / restored_stock / restored_seats`）
--    逐字沿用 0006／0011／0020／0034 那一份，一個字不改。
--
-- 第 4d 步安全的理由與 §4 相同：能進到 `expire_unpaid_orders()` 這裡被撈到的
-- 訂單，一定是 `status = 'pending'` 的、**完整**建立成功過的訂單——
-- `createOrder()` 的 try/catch 保證一張訂單只要有任何一步失敗（含 §3 那個窄窗口）
-- 就會被整個刪除，不會以「方案保留與座位保留對不上」的半成品狀態留在資料庫裡
-- 給 `expire_unpaid_orders()` 掃到。所以這裡可以放心用
-- `sum(order_items.quantity) where plan_id = ...` 當還原基準，不需要、也不能
-- 從 `event_registrations` 反推（那張表在同一步已經被刪光了）。
--
-- 鎖順序 `public.products → inv.products → event_sessions → event_session_plans`
-- （0020 §4 的順序，最後再接方案）。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §6  範圍之外的已知落差：`admin_delete_registration()`（0035）不動方案計數器
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0035 的 `admin_delete_registration()` 是**單筆**移除一位參加者（不是整個
-- order_item），還原的是 `seats_taken -= 1`。它完全不知道方案存在，這一期也
-- **刻意不改它**——這是任務書列出的驗收範圍之外的東西，硬改就是替一個沒有人
-- 決定過的問題（「雙人房拆單移除其中一位，方案的名額該不該還」）發明答案。
--
-- 結果就是：如果後台對一個 `seats_per_unit > 1` 的方案訂單只移除**部分**參加者
-- （而不是透過刪整張訂單／`admin_delete_order()`），`event_sessions.seats_taken`
-- 會正確地少 1，但 `event_session_plans.units_taken` 不會跟著動——方案的可售
-- 單位數會偏低（看起來比實際更滿）。這不是這一期造成的新洞（0035 上線時方案
-- 還不存在），但方案上線後它第一次會被踩到，寫在這裡讓下一個人不會誤以為是
-- 這一期漏測。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §7  部署順序
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 這支要先套到正式庫，程式碼才能推——`src/server/repos/orders.ts` 會直接
-- 寫入 `order_items.plan_id` / `plan_title` 兩個新欄位、呼叫
-- `reserve_plan_units()`／`release_plan_units()`，欄位或函式不存在會讓每一筆
-- 結帳都是 500，不分有沒有方案。

begin;

-- ---------------------------------------------------------------------------
-- 1. event_session_plans —— 一個場次底下的多個票種
-- ---------------------------------------------------------------------------
-- 姿勢照 event_sessions（0020 §1）：公開可讀（前台要顯示價格與剩餘），寫入只走
-- service_role。⚠️ **`units_taken` 不叫 `seats_taken`，是故意的**——它數的是
-- 賣出幾個「單位」，跟場次的 `seats_taken`（數位子）是不同的量。同名會讓日後
-- 有人把兩個數字拿去相加。
create table if not exists public.event_session_plans (
  id             uuid primary key default gen_random_uuid(),

  -- on delete cascade：方案離開它的場次沒有意義，跟 event_sessions.product_id
  -- 是同一個理由（0020 §1）。order_items.plan_id 的 on delete restrict（§2）會
  -- 擋住這個 cascade——賣過的方案刪不掉，跟賣過的場次刪不掉是同一條鏈。
  session_id     uuid not null references public.event_sessions (id) on delete cascade,

  title          jsonb not null check (public.is_localized(title)),

  -- 每「單位」的價格。方案存在時，這是 unit_price 唯一的來源——products.price
  -- 只給沒有任何 open 方案的場次當退回值（§0、以及 orders.ts 的 priceLines()）。
  price          integer not null check (price >= 0),

  -- 一個「單位」佔幾個名額。預設 1（一單位一位）；雙人房這種就是 2。
  seats_per_unit integer not null default 1 check (seats_per_unit >= 1),

  -- 這個方案自己的單位上限與已賣出——與 event_sessions.capacity/seats_taken
  -- 平行，但量綱不同（這裡數單位，那裡數位子）。
  capacity       integer not null check (capacity >= 0),
  units_taken    integer not null default 0 check (units_taken >= 0),

  -- 早鳥的時間邊界。兩者皆可為 null：null 起點＝現在就能買，null 迄點＝不設
  -- 販售期限。
  sale_starts_at timestamptz,
  sale_ends_at   timestamptz,

  status         text not null default 'open' check (status in ('open', 'closed')),
  sort_order     integer not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint event_session_plans_units_within_capacity check (units_taken <= capacity),
  constraint event_session_plans_sale_window check (
    sale_starts_at is null or sale_ends_at is null or sale_ends_at >= sale_starts_at
  )
);

comment on table public.event_session_plans is
  '一個場次底下的價格方案（票種）。名額（capacity/units_taken）以「單位」計，一個單位可能佔場次的多個座位（seats_per_unit）。沒有任何 open 方案的場次照舊讀 products.price、quantity 直接等於座位數。';
comment on column public.event_session_plans.units_taken is
  '賣出幾個「單位」，不是幾個位子——刻意不叫 seats_taken，避免與 event_sessions.seats_taken 被誤當同一個量相加。只由 reserve_plan_units() / release_plan_units() / release_session_seat() / expire_unpaid_orders() 維護，不要在別的地方寫它。';
comment on column public.event_session_plans.seats_per_unit is
  '一個購買單位佔用場次的幾個座位。1＝一單位一位（早鳥票這類）；雙人房這種是 2。reserve_session_seat() 收到的 p_quantity 必須是 quantity × seats_per_unit（座位數），不是 quantity 本身。';

create index if not exists event_session_plans_session_idx
  on public.event_session_plans (session_id, sort_order);
create index if not exists event_session_plans_open_idx
  on public.event_session_plans (status);

drop trigger if exists event_session_plans_set_updated_at on public.event_session_plans;
create trigger event_session_plans_set_updated_at
  before update on public.event_session_plans
  for each row execute function public.set_updated_at();

-- RLS：與 event_sessions 同一個形狀（0020 §1）——這張表要回答的問題（「這個方案
-- 多少錢、還剩幾個」）本來就是公開的。exists(...) 多穿一層 event_sessions 到
-- products，跟 event_sessions 自己那條 policy 穿到 products 是同一個理由：
-- 子查詢以呼叫者的身分執行，草稿商品／已關閉場次底下的方案自然查不到——
-- fail-closed。
alter table public.event_session_plans enable row level security;
revoke all on table public.event_session_plans from anon, authenticated;
grant select on table public.event_session_plans to anon, authenticated;
grant all    on table public.event_session_plans to service_role;

drop policy if exists event_session_plans_select_public on public.event_session_plans;
create policy event_session_plans_select_public on public.event_session_plans
  as permissive for select to anon, authenticated
  using (
    status = 'open'
    and exists (
      select 1
        from public.event_sessions s
        join public.products p on p.id = s.product_id
       where s.id = event_session_plans.session_id
         and s.status = 'open'
         and p.status = 'active'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. order_items —— 這一行訂的是哪一個方案
-- ---------------------------------------------------------------------------
-- on delete restrict 與 session_id 一致（0020 §3）：賣過的方案不能被刪掉。
alter table public.order_items
  add column if not exists plan_id uuid
  references public.event_session_plans (id) on delete restrict;

-- 快照，與 name / unit_price 同一個理由（0005）：方案之後改名字或下架，不能
-- 悄悄改寫既有訂單上印著的東西。
alter table public.order_items
  add column if not exists plan_title jsonb;

comment on column public.order_items.plan_id is
  '這一行訂的是哪一個方案（票種）。null＝這場沒有方案，或這一行沒有選——那時價格與名額走場次／商品本身（0020 之前的行為）。on delete restrict：賣過的方案刪不掉。';
comment on column public.order_items.plan_title is
  '方案名稱的快照。plan_id 非 null 時必須非 null 且是三語物件，反之必須是 null——見 order_items_plan_title_shape。';

create index if not exists order_items_plan_idx
  on public.order_items (plan_id)
  where plan_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'order_items_plan_title_shape'
  ) then
    alter table public.order_items
      add constraint order_items_plan_title_shape check (
        (plan_id is null and plan_title is null)
        or (plan_id is not null and plan_title is not null and public.is_localized(plan_title))
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'order_items_plan_requires_session'
  ) then
    alter table public.order_items
      add constraint order_items_plan_requires_session check (
        plan_id is null or session_id is not null
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. reserve_plan_units —— 方案自己的名額池
-- ---------------------------------------------------------------------------
-- 七步（比 reserve_session_seat 少「寫參加者」那一步，方案不直接持有任何逐位
-- 資料——參加者仍然只掛在 event_registrations，由 reserve_session_seat 寫）：
--
--   ① 參數必須存在、p_units > 0
--   ② 鎖這張訂單會碰到的所有場次（依 id 排序，for no key update）——見 §2
--   ③ 鎖這張訂單會碰到的所有方案（依 id 排序，for no key update），在場次之後
--   ④ 鎖目標方案那一列，找不到 → PLAN_NOT_FOUND
--   ⑤ 驗這個方案真的屬於這張訂單的某個 order_item，且那一行的 session_id 與
--      方案的 session_id 一致 → 否則 PLAN_ORDER_ITEM_NOT_FOUND（同
--      reserve_session_seat 第③步的理由：plan_id 是瀏覽器送上來的，這是那個
--      攻擊面的門，即使 priceLines() 已經驗過一次）
--   ⑥ 狀態與販售期間 → PLAN_NOT_OPEN / PLAN_NOT_ON_SALE_YET / PLAN_SALE_ENDED
--      （priceLines() 也驗，這裡是關掉 TOCTOU 窗口的第二道）
--   ⑦ units_taken + p_units > capacity → NO_PLAN_UNITS_LEFT；否則相對更新
create or replace function public.reserve_plan_units(
  p_order_id uuid,
  p_plan_id  uuid,
  p_units    integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id     uuid;
  v_capacity       integer;
  v_taken          integer;
  v_status         text;
  v_sale_starts_at timestamptz;
  v_sale_ends_at   timestamptz;
begin
  if p_order_id is null or p_plan_id is null then
    raise exception 'MISSING_ARGUMENT' using errcode = 'check_violation';
  end if;
  if p_units is null or p_units <= 0 then
    raise exception 'INVALID_UNITS:%', p_units using errcode = 'check_violation';
  end if;

  -- ---- ② 鎖場次（與 reserve_session_seat 同一批、同一個順序）----------------
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

  -- ---- ③ 鎖方案（在場次之後）------------------------------------------------
  perform 1
    from public.event_session_plans p
   where p.id in (
           select oi.plan_id
             from public.order_items oi
            where oi.order_id = p_order_id
              and oi.plan_id is not null
         )
   order by p.id
     for no key update;

  -- ---- ④ 目標方案 ------------------------------------------------------------
  select p.session_id, p.capacity, p.units_taken, p.status, p.sale_starts_at, p.sale_ends_at
    into v_session_id, v_capacity, v_taken, v_status, v_sale_starts_at, v_sale_ends_at
    from public.event_session_plans p
   where p.id = p_plan_id
     for no key update;
  if not found then
    raise exception 'PLAN_NOT_FOUND:%', p_plan_id using errcode = 'check_violation';
  end if;

  -- ---- ⑤ 這個方案真的屬於這張訂單、這個場次 ----------------------------------
  if not exists (
    select 1
      from public.order_items oi
     where oi.order_id   = p_order_id
       and oi.plan_id    = p_plan_id
       and oi.session_id = v_session_id
  ) then
    raise exception 'PLAN_ORDER_ITEM_NOT_FOUND:%', p_plan_id using errcode = 'check_violation';
  end if;

  -- ---- ⑥ 狀態與販售期間 -------------------------------------------------------
  if v_status <> 'open' then
    raise exception 'PLAN_NOT_OPEN:%', p_plan_id using errcode = 'check_violation';
  end if;
  if v_sale_starts_at is not null and now() < v_sale_starts_at then
    raise exception 'PLAN_NOT_ON_SALE_YET:%', p_plan_id using errcode = 'check_violation';
  end if;
  if v_sale_ends_at is not null and now() > v_sale_ends_at then
    raise exception 'PLAN_SALE_ENDED:%', p_plan_id using errcode = 'check_violation';
  end if;

  -- ---- ⑦ 超額 / 佔位 -----------------------------------------------------------
  if v_taken + p_units > v_capacity then
    raise exception 'NO_PLAN_UNITS_LEFT:%', p_plan_id using errcode = 'check_violation';
  end if;

  update public.event_session_plans
     set units_taken = units_taken + p_units
   where id = p_plan_id;

  return p_units;
end;
$$;

comment on function public.reserve_plan_units(uuid, uuid, integer) is
  '方案自己的名額池。鎖序固定「場次→方案」，兩者皆依 id 排序、for no key update（見檔頭 §2）。四種驗證失敗（不存在／不屬於這張訂單或這個場次／已下架／超出販售期間）各自有獨立錯誤字串，但 src/server/repos/orders.ts 的 priceLines() 已經在呼叫這支之前用同一句「product_unavailable」把它們合併——這裡的區分只給 log 用，不是給客人看的。';

-- ---------------------------------------------------------------------------
-- 4. release_plan_units —— 🔴 新增：createOrder() 專用的窄窗口補救（見檔頭 §3）
-- ---------------------------------------------------------------------------
-- 只在一個地方被呼叫：orders.ts 的 createOrder() 在 reserve_plan_units() 成功、
-- 緊接著同一行的 reserve_session_seat() 卻失敗的那一刻，直接用「剛剛真的保留了
-- 多少」這個呼叫端本來就知道的數字去扣，不經過 order_items 反推。
--
-- 只鎖方案那一列，不鎖場次——這支從不讀寫 event_sessions，兩個資源之間沒有
-- 「互相持有再互相等待」的可能，不受檔頭 §2「場次先、方案後」那條規矩約束
-- （那條規矩是給會同時碰兩張表的交易用的）。
--
-- best effort、絕不 throw，與 release_session_seat() 同一個契約（0020 §8）：
-- 它跑在 orders.ts 自己的錯誤處理路徑上，不可以再拋一個新錯誤把原本要回報的
-- 錯誤蓋掉。
create or replace function public.release_plan_units(
  p_plan_id uuid,
  p_units   integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_plan_id is null or p_units is null or p_units <= 0 then
    return 0;
  end if;

  perform 1 from public.event_session_plans p where p.id = p_plan_id for no key update;

  update public.event_session_plans p
     set units_taken = greatest(0, p.units_taken - p_units)
   where p.id = p_plan_id;

  return p_units;
exception
  when others then
    return 0;
end;
$$;

comment on function public.release_plan_units(uuid, integer) is
  '窄窗口補救：createOrder() 對同一行的 reserve_plan_units() 成功、reserve_session_seat() 隨即失敗時，直接呼叫這支扣回剛剛保留的 p_units，不經過 order_items 反推（見 0036 檔頭 §3——反推在這個特定窗口會偷到別的訂單合法持有的 units_taken）。只鎖方案，不鎖場次。best effort，絕不 throw。';

-- ---------------------------------------------------------------------------
-- 5. release_session_seat —— 加一句「一併回沖方案的 units_taken」
-- ---------------------------------------------------------------------------
-- 簽章逐字不變：public.release_session_seat(bigint)。0020 §8 的七行本體保留，
-- 只在「registrations 真的刪掉了」（v_freed > 0）那個既有的 if 區塊裡多兩句。
-- 還原量用 order_item 自己的 quantity，理由見檔頭 §4——這條路徑上讀到的
-- plan_id/quantity 保證與真正被保留的狀態一致（§3 那個窄窗口已經在
-- createOrder() 當場處理掉了，不會流到這裡）。
create or replace function public.release_session_seat(p_order_item_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session  uuid;
  v_freed    integer := 0;
  v_plan_id  uuid;
  v_quantity integer;
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

  -- 0036：這個 order_item 訂的是不是一個方案——先讀出來，決定等一下要不要
  -- 也還方案名額。order_items 是 insert-only、不會變，讀它不需要鎖。
  select oi.plan_id, oi.quantity into v_plan_id, v_quantity
    from public.order_items oi
   where oi.id = p_order_item_id;

  -- 場次先鎖，方案後鎖——與 reserve_plan_units() 同一個固定順序（檔頭 §2）。
  perform 1 from public.event_sessions s where s.id = v_session for no key update;
  if v_plan_id is not null then
    perform 1 from public.event_session_plans p where p.id = v_plan_id for no key update;
  end if;

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

    -- 0036：方案名額一併回沖。用 order_item 自己的 quantity（買了幾個單位），
    -- 不是 v_freed / seats_per_unit——這裡整個 order_item 的所有位子都被刪掉了
    -- （上面那句 DELETE），所以要還的就是這一行原本買的單位數，不必換算。
    if v_plan_id is not null then
      update public.event_session_plans p
         set units_taken = greatest(0, p.units_taken - coalesce(v_quantity, 0))
       where p.id = v_plan_id;
    end if;
  end if;

  return v_freed;
exception
  when others then
    return 0;
end;
$$;

comment on function public.release_session_seat(bigint) is
  '回收一個 order_item 佔住的位子、參加者，並一併回沖它的方案名額（0036）。DELETE…RETURNING 當冪等 claim，第二次回 0（兩個回沖都跟著是 no-op）。絕不 throw。';

-- ---------------------------------------------------------------------------
-- 6. expire_unpaid_orders —— 加一句「放掉方案名額」（第 4d 步）
-- ---------------------------------------------------------------------------
-- ⚠️ RETURNS TABLE 形狀（expired_id uuid, expired_order_no text,
--    restored_stock integer, restored_seats integer）逐字沿用 0006／0011／
--    0020／0034——見檔頭 §5。這裡整支函式本體照 0034 那一份逐字照抄，只加第
--    4d 步。
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
  -- 0034：匯款訂單至少留 3 天，門檻取 greatest(p_older_than, 3 天)——這一支
  -- 逐字沿用，一個字不改。
  select array_agg(c.id)
    into v_ids
    from (
      select o.id
        from public.orders o
       where o.status = 'pending'
         and o.payment_status <> 'paid'
         and o.paid_at is null
         and o.created_at < now() - (case when o.payment_method = 'transfer'
                                          then greatest(p_older_than, interval '3 days')
                                          else p_older_than end)
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
  -- 逐字保留。
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

  -- ---- 4b. 放掉進銷存的保留（0011）---------------------------------------
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

  -- ---- 4c. 放掉場次名額與參加者（0020）-----------------------------------
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

  -- ---- 4d. 放掉方案名額（0036 新增）---------------------------------------
  -- 與 4c 同一個理由、同一個鎖順序（場次已經鎖過，這裡鎖方案，在後面）。用
  -- order_items.quantity 當還原基準，不是從 event_registrations 反推——這條
  -- 路徑上的 order_item 保證方案保留與座位保留同時成立（見檔頭 §5），
  -- 「這行原本買了幾個單位」就是要還的量，不必換算 seats_per_unit。
  perform 1
    from public.event_session_plans p
   where p.id in (
           select oi.plan_id
             from public.order_items oi
            where oi.order_id = any(v_ids)
              and oi.plan_id is not null
         )
   order by p.id
     for no key update;

  update public.event_session_plans p
     set units_taken = greatest(0, p.units_taken - agg.qty)
    from (
      select oi.plan_id as pid, sum(oi.quantity)::integer as qty
        from public.order_items oi
       where oi.order_id = any(v_ids)
         and oi.plan_id is not null
       group by oi.plan_id
    ) agg
   where p.id = agg.pid;

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
           -- 0036：座位數是 quantity × seats_per_unit，不是 quantity 本身
           -- （沒有方案的行 left join 不到，coalesce 落回 1，逐字沿用舊行為）。
           -- restored_seats 這個名字說的是位子，不是單位，漏乘會低報雙人房
           -- 這類方案實際還了幾個位子——雖然目前沒有任何呼叫端讀這個回傳值，
           -- 但它是這支函式對外唯一的「還了多少」證詞，值必須是對的。
           coalesce((
             select sum(oi.quantity * coalesce(esp.seats_per_unit, 1))::integer
               from public.order_items oi
               join public.products pr on pr.id = oi.product_id
               left join public.event_session_plans esp on esp.id = oi.plan_id
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
  '0034 版本 + 第 4d 步：一併放掉 event_session_plans 的 units_taken。RETURNS TABLE 形狀與 0006／0011／0020／0034 逐字相同。';

-- ---------------------------------------------------------------------------
-- 7. 權限
-- ---------------------------------------------------------------------------
-- 與 0020 §11／0035 §6 同一套處理：PostgreSQL 建立函式時預設把 EXECUTE 授給
-- PUBLIC，所以「從 public revoke」才是真正生效的那一半。
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.reserve_plan_units(uuid, uuid, integer)',
    'public.release_plan_units(uuid, integer)'
  ]
  loop
    execute format('revoke execute on function %s from public', sig);
    execute format('revoke execute on function %s from anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end loop;
end $$;

-- 覆寫掉的那兩支也重跑一次，避免 create or replace 之後權限漂移（0020 §11 的
-- 同一句提醒）。
revoke execute on function public.release_session_seat(bigint) from public;
revoke execute on function public.release_session_seat(bigint) from anon, authenticated;
grant  execute on function public.release_session_seat(bigint) to service_role;

revoke execute on function public.expire_unpaid_orders(interval, integer) from public;
revoke execute on function public.expire_unpaid_orders(interval, integer) from anon, authenticated;
grant  execute on function public.expire_unpaid_orders(interval, integer) to service_role;

commit;
