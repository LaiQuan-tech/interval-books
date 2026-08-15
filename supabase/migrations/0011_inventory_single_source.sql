-- 0011_inventory_single_source.sql —— 庫存單一真相：網站賣進銷存的實體庫存
--
-- 0009 把進銷存 21 張表搬進 inv，0010 接好身分。但兩邊的商品還是各算各的庫存：
-- public.products.stock 是型錄自己的數字，inv.products.stock_quantity 是店裡真正
-- 的貨。這個檔案把後者變成唯一的真相，並且**不動任何一行既有 migration**。
--
-- ── 為什麼網站不能直接寫 inv.sales ────────────────────────────────────────
-- 兩條既有路徑的語意完全不同：
--
--   網站 public.atomic_deduct_stock()（0004）
--     下單當下扣、30 分沒付款由 expire_unpaid_orders()（0006）還原、有下限檢查。
--     「扣了還能還」是它的前提。
--
--   進銷存 inv.update_stock_on_sale()（0009，AFTER INSERT ON inv.sales）
--     sales 進一列就扣、**終局**、**沒有下限檢查**（這正是搬遷前庫存會出現負數的
--     原因）。它的前提是「這一列代表錢已經收了」。
--
-- 把網站接到後者，等於讓**還沒付款的購物車**在進銷存產生銷售紀錄。那些列會汙染
-- 營收報表、被 inv.allocate_fifo_cost() 拿去分攤成本、進到供應商對帳，然後 30 分鐘
-- 後又要被刪掉。刪掉還會觸發 rollback_fifo_on_sale_delete。這不是「多寫幾列再清掉」
-- 的問題，是進銷存的帳會有一段時間是錯的，而且錯的那段時間剛好是有人在看報表的時候。
--
-- ── 正確的做法：實體庫存不動，未付款走保留 ledger ────────────────────────
--
--     可售量 = inv.products.stock_quantity − Σ stock_reservations.quantity
--
-- 下單只寫 stock_reservations（一列保留），**stock_quantity 一動也不動**。
-- 付款成功才寫 inv.sales，由既有 trigger 去扣真正的庫存。沒付款就刪掉保留列，
-- 實體庫存從頭到尾沒被碰過 —— 所以「還原」不需要任何補償寫入，也不會在 inv 留下
-- 任何一列垃圾。這是相對於「直接寫 sales 再刪掉」最關鍵的優勢。
--
-- ── 併發正確性：全靠一條規矩 ─────────────────────────────────────────────
-- ⚠️ **所有會動到某個 inv 品項的路徑，第一步都是「依 id 排序對 inv.products 取
--    FOR UPDATE」**。這一條沒有例外。
--
-- 「讀 reservation 加總 → 判斷夠不夠 → 寫新的 reservation」是典型的
-- read-modify-write，兩個併發請求都讀到「還有 1 個」就會雙雙通過，這就是超賣。
-- 行鎖讓第二個請求必須等第一個 commit 之後才讀得到加總，於是它讀到的是新的事實。
-- 這跟 0004 的 atomic_deduct_stock() 是同一招，只是鎖的對象從 public.products
-- 換成 inv.products。
--
-- 跨表的鎖順序也固定：**先 public.products，再 inv.products**。目前只有
-- expire_unpaid_orders() 會在同一個交易裡碰到兩張表；結帳雖然兩張都碰，但
-- reserve 與 atomic_deduct 是 PostgREST 的兩次呼叫＝兩個交易，不會同時持有。
--
-- 前一個 migration：0010_inventory_identity.sql。既有 0001–0010 一律不動。

begin;

-- ---------------------------------------------------------------------------
-- 1. product_inventory_links —— 型錄商品 ↔ 進銷存品項
-- ---------------------------------------------------------------------------
-- ⚠️ 用「一張表」而不是「public.products 上加一個欄位」，理由是 event / journey
-- 這兩種 product_type 根本沒有實體庫存。加欄位的話它們永遠是 NULL，而「NULL 代表
-- 什麼」就得靠讀程式碼才知道；用表的話，**沒有連結列**這件事本身就完整表達了
-- 「這個商品不受實體庫存管」，而且 join 不到就是 join 不到，不需要任何人記得。
--
-- inv_product_id 是 unique：一個進銷存品項只能上架成一個型錄商品。允許一對多的話，
-- 兩個型錄商品會共用同一份庫存，而「賣掉哪一個」在報表上分不出來。
--
-- on delete restrict（往 inv 那側）：進銷存的品項被刪掉時，型錄不該跟著人間蒸發，
-- 而是應該擋下刪除、讓店員先決定型錄要怎麼辦。
create table if not exists public.product_inventory_links (
  product_id     text primary key
                 references public.products (id) on delete cascade,
  inv_product_id uuid not null unique
                 references inv.products (id) on delete restrict,

  -- 賣出「1 個型錄商品」等於出「幾個進銷存品項」。預設 1。
  -- 這與 inv.products.pack_size 是**不同層次**的倍數：pack_size 是進銷存自己的
  -- 「一盒＝幾支」，units_per_sale 是型錄自己的「一組＝幾盒」。兩個會相乘。
  units_per_sale integer not null default 1 check (units_per_sale > 0),

  created_at     timestamptz not null default now()
);

comment on table public.product_inventory_links is
  '型錄商品 ↔ 進銷存品項。沒有列＝這個商品不受實體庫存管（event/journey 或純型錄品）。';
comment on column public.product_inventory_links.units_per_sale is
  '一個型錄商品出幾個進銷存品項。會再乘上 inv.products.pack_size。';

create index if not exists product_inventory_links_inv_idx
  on public.product_inventory_links (inv_product_id);

-- 與 0005 對電商表的處置一致：RLS 開著、零 policy、瀏覽器兩把金鑰零 grant。
alter table public.product_inventory_links enable row level security;
revoke all on table public.product_inventory_links from anon, authenticated;
grant all on table public.product_inventory_links to service_role;

-- ---------------------------------------------------------------------------
-- 2. stock_reservations —— 未付款訂單握住的量
-- ---------------------------------------------------------------------------
-- 這張表就是「可售量」與「實體庫存」之間的差額。每一列代表「某張訂單先押住某個
-- 進銷存品項 N 個」，而那 N 個**還在架上**（stock_quantity 沒有變）。
--
-- inv_product_id 存的是**解析後的扣庫存目標**（見 inv.resolve_stock_target），
-- 不是型錄連到的那個品項。原因見第 4 節。
--
-- unique(order_id, inv_product_id)：同一張訂單對同一個目標只會有一列。兩個不同的
-- 型錄商品若解析到同一個 base product，reserve 會先加總再寫一列。
create table if not exists public.stock_reservations (
  id             bigserial primary key,
  order_id       uuid not null references public.orders (id) on delete cascade,
  inv_product_id uuid not null references inv.products (id) on delete restrict,
  quantity       integer not null check (quantity > 0),
  created_at     timestamptz not null default now(),
  unique (order_id, inv_product_id)
);

comment on table public.stock_reservations is
  '未付款訂單握住的進銷存數量。可售量 = inv.products.stock_quantity − Σ 這裡的 quantity。實體庫存從不因為保留而變動。';
comment on column public.stock_reservations.inv_product_id is
  '已經解析過 base_product_id 的**實際扣庫存目標**，不是型錄連到的那個品項。';

-- 每次算可售量都要對某個 inv 品項做 sum(quantity)，這個索引是那條路徑的全部。
create index if not exists stock_reservations_inv_product_idx
  on public.stock_reservations (inv_product_id);

alter table public.stock_reservations enable row level security;
revoke all on table public.stock_reservations from anon, authenticated;
grant all on table public.stock_reservations to service_role;

-- ---------------------------------------------------------------------------
-- 3. stock_oversold_alerts —— 賣超了，等人來處理
-- ---------------------------------------------------------------------------
-- 兩個來源，都是**刻意放行**的結果，不是 bug：
--   online_commit —— 付款成功時庫存不夠。錢已經收了，不可能失敗（見第 6 節）。
--   pos_override  —— 店員在櫃檯按了「客人就站在這裡，先賣」。
--
-- order_id 允許 NULL：POS 的逃生門沒有網路訂單。
-- on delete set null 而不是 cascade：訂單可以被刪，但「那天賣超了」這件事不行。
create table if not exists public.stock_oversold_alerts (
  id             bigserial primary key,
  order_id       uuid references public.orders (id) on delete set null,
  inv_product_id uuid not null references inv.products (id) on delete restrict,
  shortfall      integer not null check (shortfall > 0),
  source         text not null default 'online_commit'
                 check (source in ('online_commit', 'pos_override')),
  sale_id        uuid,
  created_at     timestamptz not null default now()
);

comment on table public.stock_oversold_alerts is
  '賣超紀錄。online_commit＝付款成功但庫存不足（刻意放行，錢已收）；pos_override＝店員在櫃檯強制放行。兩者都要有人去處理。';

create index if not exists stock_oversold_alerts_created_idx
  on public.stock_oversold_alerts (created_at desc);

alter table public.stock_oversold_alerts enable row level security;
revoke all on table public.stock_oversold_alerts from anon, authenticated;
grant all on table public.stock_oversold_alerts to service_role;

-- ---------------------------------------------------------------------------
-- 4. inv.sales 三個新欄位
-- ---------------------------------------------------------------------------
-- channel 預設 'pos'，所以**既有的 665 列與既有的 POS 程式碼一行都不用改**：
-- 不指定 channel 就是店面銷售，行為與今天完全相同。
--
-- override_reservation 是櫃檯的逃生門。它預設 false，而且每次被設成 true 都會在
-- stock_oversold_alerts 留一列 —— 逃生門可以走，但要留痕。
alter table inv.sales
  add column if not exists channel text not null default 'pos';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sales_channel_check'
      and conrelid = 'inv.sales'::regclass
  ) then
    alter table inv.sales
      add constraint sales_channel_check check (channel in ('pos', 'online'));
  end if;
end $$;

alter table inv.sales
  add column if not exists web_order_id uuid references public.orders (id);

alter table inv.sales
  add column if not exists override_reservation boolean not null default false;

comment on column inv.sales.channel is
  'pos＝店面（預設，既有列與既有程式碼都是這個）｜online＝網站訂單付款成功後由 commit_inventory_reservations() 寫入。';
comment on column inv.sales.web_order_id is
  '對應的 public.orders.id。只有 channel=online 會有值，是進銷存回查網路訂單的唯一線索。';
comment on column inv.sales.override_reservation is
  '店員在櫃檯強制放行（略過可售量下限檢查）。設成 true 一定會寫一列 stock_oversold_alerts。';

create index if not exists sales_web_order_idx
  on inv.sales (web_order_id) where web_order_id is not null;

-- ---------------------------------------------------------------------------
-- 5. inv.resolve_stock_target —— base_product_id × pack_size 的唯一解析點
-- ---------------------------------------------------------------------------
-- 進銷存的「外帶紅烏龍茶餅」是「紅烏龍茶餅」的 pack：它自己的 stock_quantity 沒有
-- 意義，賣一個要從 base product 扣 pack_size 個。inv.update_stock_on_sale() 與
-- inv.allocate_fifo_cost() 各自寫了一份一模一樣的解析邏輯；這裡是第三份，但它是
-- 唯一一份會被新程式碼呼叫的，而且與那兩份的行為逐字對齊：
--
--   base_product_id IS NULL  → 扣自己，倍數 1
--   base_product_id NOT NULL → 扣 base，倍數 coalesce(pack_size, 1)
--
-- ⚠️ 倍數只在 base_product_id 非空時生效。pack_size 對沒有 base 的品項是死欄位，
--    照抄既有行為，不要「順手修正」。
--
-- 查不到 id 就回 0 列（不是回 NULL）—— 讓 join 自然地把它濾掉。
create or replace function inv.resolve_stock_target(p_product_id uuid)
returns table (target_id uuid, multiplier integer)
language sql
stable
security definer
set search_path = inv, public
as $$
  select coalesce(p.base_product_id, p.id),
         case when p.base_product_id is not null then coalesce(p.pack_size, 1) else 1 end
    from inv.products p
   where p.id = p_product_id;
$$;

comment on function inv.resolve_stock_target(uuid) is
  '解析一個進銷存品項實際該扣哪一列、扣幾倍。與 update_stock_on_sale() / allocate_fifo_cost() 的內建邏輯逐字對齊。';

-- ---------------------------------------------------------------------------
-- 6. reserve_inventory_stock —— 下單時呼叫（可逆）
-- ---------------------------------------------------------------------------
-- p_items: [{"product_id": "<public.products.id>", "quantity": 2}, ...]
--
-- 沒有連結列的商品會被 join 自然濾掉 —— 那些商品走 0004 的 atomic_deduct_stock()，
-- 這裡不該碰它們（碰了就是同一份庫存扣兩次）。
--
-- 數量的三層相乘：
--   訂購數 × product_inventory_links.units_per_sale × resolve_stock_target 的倍數
--
-- ⚠️ pack_size 必須在**這裡**（保留階段）就解析完。若留到付款才解析，保留 ledger
--    記的是 pack 的數量、實體庫存記的是 base 的數量，可售量會整個算錯（差 pack_size
--    倍），而且錯的方向是**高估**——也就是會超賣。
--
-- 失敗一律 raise，讓整個交易回捲。呼叫端必須讓例外往上傳，這與 atomic_deduct_stock()
-- 的契約相同。
create or replace function public.reserve_inventory_stock(
  p_order_id uuid,
  p_items    jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      record;
  v_reserved integer := 0;
begin
  if p_order_id is null then
    raise exception 'NULL_ORDER_ID';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'INVALID_ITEMS';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) e
     where coalesce((e ->> 'quantity')::integer, 0) <= 0
  ) then
    raise exception 'INVALID_QUANTITY';
  end if;

  -- ---- 第一步，永遠是這一步：依 id 排序鎖住所有目標列 --------------------
  -- 排序是防死鎖（兩張訂單含相同兩個品項但順序相反）；FOR UPDATE 是防超賣
  -- （下面那段「讀加總 → 判斷 → 寫入」是 read-modify-write，沒有鎖就會雙雙通過）。
  perform 1
    from inv.products ip
   where ip.id in (
           select t.target_id
             from jsonb_array_elements(p_items) e
             join public.product_inventory_links l
               on l.product_id = (e ->> 'product_id')
             cross join lateral inv.resolve_stock_target(l.inv_product_id) t
         )
   order by ip.id
     for update;

  -- ---- 判斷與寫入 --------------------------------------------------------
  for v_row in
    with need as (
      select t.target_id,
             sum((e ->> 'quantity')::integer * l.units_per_sale * t.multiplier)::integer as qty
        from jsonb_array_elements(p_items) e
        join public.product_inventory_links l
          on l.product_id = (e ->> 'product_id')
        cross join lateral inv.resolve_stock_target(l.inv_product_id) t
       group by t.target_id
    )
    select n.target_id,
           n.qty,
           ip.stock_quantity
             - coalesce((select sum(r.quantity)::integer
                           from public.stock_reservations r
                          where r.inv_product_id = n.target_id), 0) as available
      from need n
      join inv.products ip on ip.id = n.target_id
     order by n.target_id
  loop
    if v_row.available < v_row.qty then
      raise exception 'INSUFFICIENT_STOCK:%', v_row.target_id
        using errcode = 'check_violation';
    end if;

    -- 同一張訂單重複呼叫會撞 unique(order_id, inv_product_id) 而 23505。
    -- 那是刻意的：重複呼叫代表呼叫端有 bug（訂單 id 是每次結帳新生的），
    -- 靜默累加會讓同一張訂單押住兩倍的貨。
    insert into public.stock_reservations (order_id, inv_product_id, quantity)
    values (p_order_id, v_row.target_id, v_row.qty);

    v_reserved := v_reserved + 1;
  end loop;

  return v_reserved;
end;
$$;

comment on function public.reserve_inventory_stock(uuid, jsonb) is
  '下單時押住可售量，不動實體庫存。先依 id 排序 FOR UPDATE 再判斷，這是唯一防超賣的機制。庫存不足時 raise INSUFFICIENT_STOCK。';

-- ---------------------------------------------------------------------------
-- 7. commit_inventory_reservations —— 付款成功時呼叫（不可逆）
-- ---------------------------------------------------------------------------
-- ⚠️⚠️ 這支函式**絕對不能因為庫存不足而失敗**。
--
-- 它只在「PayUni 已經確認收到錢」之後才被呼叫。如果它拋錯，webhook 會回 5xx、
-- 訂單留在 pending，30 分鐘後 expire_unpaid_orders() 會把它取消掉 —— 結果是
-- **客人付了錢，卻沒有訂單**。相比之下，庫存變成負數只是店裡少一本書要跟客人道歉。
-- 所以這裡允許負庫存，並寫一列 stock_oversold_alerts 讓店員去處理。
-- 這是刻意的例外，不要「順手加上」下限檢查。
--
-- 冪等：用 DELETE ... RETURNING 當 claim。webhook 重送時保留列已經被第一次刪光，
-- RETURNING 沒有列 → 直接回 0，不會重複寫 inv.sales、不會重複扣庫存。這與 0007 的
-- claim_invoice_issue() 是同一個模式：**能刪到才代表這一次是真的**。
--
-- 回傳：這次寫了幾列 stock_oversold_alerts（0 = 一切正常，或這是重送）。
create or replace function public.commit_inventory_reservations(
  p_order_id      uuid,
  p_staff_user_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before   jsonb;
  v_claimed  jsonb;
  v_line     record;
  v_target   record;
  v_stock    integer;
  v_short    integer;
  v_oversold integer := 0;
begin
  if p_order_id is null then
    raise exception 'NULL_ORDER_ID';
  end if;

  -- ---- 第一步，永遠是這一步：依 id 排序鎖住所有目標列 --------------------
  perform 1
    from inv.products ip
   where ip.id in (
           select r.inv_product_id
             from public.stock_reservations r
            where r.order_id = p_order_id
         )
   order by ip.id
     for update;

  -- ---- 扣之前的庫存快照（算 shortfall 用，必須在寫 sales 之前拍） --------
  select jsonb_object_agg(ip.id::text, ip.stock_quantity)
    into v_before
    from inv.products ip
   where ip.id in (
           select r.inv_product_id
             from public.stock_reservations r
            where r.order_id = p_order_id
         );

  -- ---- 冪等 claim：能刪到才算數 ------------------------------------------
  with claimed as (
    delete from public.stock_reservations r
     where r.order_id = p_order_id
    returning r.inv_product_id, r.quantity
  )
  select jsonb_object_agg(c.inv_product_id::text, c.quantity)
    into v_claimed
    from claimed c;

  if v_claimed is null then
    -- 沒有保留列可刪：不是這張訂單沒有實體商品，就是 webhook 重送。
    -- 兩種情況都不該再寫一次 inv.sales。
    return 0;
  end if;

  -- ---- 寫 inv.sales，讓既有 trigger 去扣真正的庫存 -----------------------
  -- ⚠️ 這裡刻意送**原始的** inv 品項 id 與**原始的**數量（只乘 units_per_sale，
  --    不乘 pack_size）。inv.update_stock_on_sale() 會自己再解析一次 base_product_id
  --    與 pack_size —— 我們送已解析的值進去，它會再乘一次，變成扣 pack_size² 倍。
  --    保留 ledger 記解析後的、sales 記解析前的，兩者不是不一致，是各自對應到
  --    各自的讀者。
  for v_line in
    select l.inv_product_id                      as src_product_id,
           (oi.quantity * l.units_per_sale)      as sale_qty,
           oi.unit_price                         as unit_price,
           ip.user_id                            as owner_id,
           ip.name                               as item_name
      from public.order_items oi
      join public.product_inventory_links l on l.product_id = oi.product_id
      join inv.products ip on ip.id = l.inv_product_id
     where oi.order_id = p_order_id
     order by l.inv_product_id
  loop
    -- user_id 是 NOT NULL。網路訂單沒有店員，所以退回「這個品項的擁有者」——
    -- 那是進銷存自己對「這批貨是誰的」的答案，FK 一定成立，而且對報表來說歸屬正確。
    insert into inv.sales (
      user_id, product_id, quantity, unit_price, amount,
      item_name, sale_date, channel, web_order_id, notes
    )
    values (
      coalesce(p_staff_user_id, v_line.owner_id),
      v_line.src_product_id,
      v_line.sale_qty,
      v_line.unit_price,
      v_line.unit_price * v_line.sale_qty,
      v_line.item_name,
      current_date,
      'online',
      p_order_id,
      '網路訂單自動入帳'
    );
  end loop;

  -- ---- 賣超告警 ----------------------------------------------------------
  -- greatest(v_stock, 0)：扣之前就已經是負的話，這次扣的全部都沒有貨在背後。
  for v_target in
    select key::uuid as tid, value::integer as qty from jsonb_each_text(v_claimed)
  loop
    v_stock := (v_before ->> v_target.tid::text)::integer;
    v_short := greatest(0, v_target.qty - greatest(coalesce(v_stock, 0), 0));
    if v_short > 0 then
      insert into public.stock_oversold_alerts (order_id, inv_product_id, shortfall, source)
      values (p_order_id, v_target.tid, v_short, 'online_commit');
      v_oversold := v_oversold + 1;
    end if;
  end loop;

  return v_oversold;
end;
$$;

comment on function public.commit_inventory_reservations(uuid, uuid) is
  '付款成功後把保留轉成 inv.sales。DELETE…RETURNING 當冪等 claim，webhook 重送回 0。**永不因庫存不足而失敗**（錢已收），改寫 stock_oversold_alerts。回傳賣超列數。';

-- ---------------------------------------------------------------------------
-- 8. release_inventory_reservations —— 失敗與過期的回收
-- ---------------------------------------------------------------------------
-- 「還原」就是刪掉保留列，沒有任何補償寫入 —— 因為實體庫存從頭到尾沒被動過。
-- 這正是這個設計相對於「先寫 sales 再刪掉」的關鍵優勢：inv 不會多出任何一列，
-- 報表不會有一段時間是錯的。
--
-- 一樣先鎖再刪。刪保留列只會讓可售量變多，本身不會超賣，但把鎖順序統一成同一條
-- 規矩，才不用每次新增路徑時都重新推導一次「這條要不要鎖」。
create or replace function public.release_inventory_reservations(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer;
begin
  if p_order_id is null then
    raise exception 'NULL_ORDER_ID';
  end if;

  perform 1
    from inv.products ip
   where ip.id in (
           select r.inv_product_id
             from public.stock_reservations r
            where r.order_id = p_order_id
         )
   order by ip.id
     for update;

  with gone as (
    delete from public.stock_reservations r
     where r.order_id = p_order_id
    returning 1
  )
  select count(*)::integer into v_released from gone;

  return v_released;
end;
$$;

comment on function public.release_inventory_reservations(uuid) is
  '回收一張訂單押住的可售量。實體庫存從未變動，所以「還原」就是刪列，不寫任何補償。';

-- ---------------------------------------------------------------------------
-- 9. inv.update_stock_on_sale —— 加上下限檢查（POS 端）
-- ---------------------------------------------------------------------------
-- ⚠️ create or replace 覆寫 0009 裡的同名函式。0009 檔案一個字都不改；既有的
--    on_sale_insert trigger 綁的是函式名稱，所以換掉函式體即可，trigger 不用重建。
--
-- 相對 0009 的差異只有一處：扣之前先算可售量，不夠就擋。**其餘邏輯逐字保留**，
-- 包含那段 product_type = 'secondhand' 的死碼（0009 的註解解釋了為什麼留著）。
--
-- 兩個不檢查的例外：
--   channel = 'online'         —— 錢已經收了。這條路徑的失敗會讓客人付了錢沒訂單，
--                                 見第 7 節。負庫存由 commit 那邊寫告警。
--   override_reservation = true —— 店員按了「客人就站在櫃檯」。這是逃生門，走得過去，
--                                  但下面會強制寫一列 stock_oversold_alerts 留痕。
create or replace function inv.update_stock_on_sale()
returns trigger
language plpgsql
security definer
set search_path to 'inv', 'public'
as $$
DECLARE
  v_product_type text;
  v_base_product_id uuid;
  v_pack_size integer;
  v_deduct_product_id uuid;
  v_deduct_quantity integer;
  v_stock integer;
  v_reserved integer;
  v_available integer;
BEGIN
  IF NEW.product_id IS NULL OR NEW.is_secondhand = true THEN
    RETURN NEW;
  END IF;

  SELECT product_type, base_product_id, pack_size
  INTO v_product_type, v_base_product_id, v_pack_size
  FROM inv.products
  WHERE id = NEW.product_id;

  -- ⚠️ 死碼，刻意保留（0009 搬遷時的判斷，這裡原樣沿用）：products.product_type
  -- 的 CHECK 只允許 outright/consignment/rental，所以 = 'secondhand' 永遠不成立。
  IF v_product_type IS NULL OR v_product_type = 'secondhand' THEN
    RETURN NEW;
  END IF;

  IF v_base_product_id IS NOT NULL THEN
    v_deduct_product_id := v_base_product_id;
    v_deduct_quantity := NEW.quantity * COALESCE(v_pack_size, 1);
  ELSE
    v_deduct_product_id := NEW.product_id;
    v_deduct_quantity := NEW.quantity;
  END IF;

  -- ---- 先鎖目標列，再算可售量（同一條規矩） ------------------------------
  SELECT stock_quantity INTO v_stock
    FROM inv.products
   WHERE id = v_deduct_product_id
     FOR UPDATE;

  SELECT COALESCE(SUM(r.quantity), 0)::integer INTO v_reserved
    FROM public.stock_reservations r
   WHERE r.inv_product_id = v_deduct_product_id;

  v_available := COALESCE(v_stock, 0) - v_reserved;

  IF COALESCE(NEW.channel, 'pos') = 'pos'
     AND COALESCE(NEW.override_reservation, false) = false THEN
    IF v_available < v_deduct_quantity THEN
      -- 0009 沒有這一條，所以搬遷前的資料裡有負庫存。擋在這裡而不是擋在前端，
      -- 是因為前端有好幾個入口（POS、二手、組合），而它們最後都會走到這個 trigger。
      RAISE EXCEPTION 'INSUFFICIENT_STOCK:%', v_deduct_product_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF COALESCE(NEW.override_reservation, false) = true
        AND v_available < v_deduct_quantity THEN
    -- 逃生門留痕。order_id 是 NULL：櫃檯的強制放行沒有對應的網路訂單。
    INSERT INTO public.stock_oversold_alerts
      (order_id, inv_product_id, shortfall, source, sale_id)
    VALUES
      (NULL, v_deduct_product_id, v_deduct_quantity - v_available, 'pos_override', NEW.id);
  END IF;

  UPDATE inv.products
  SET stock_quantity = stock_quantity - v_deduct_quantity
  WHERE id = v_deduct_product_id;

  RETURN NEW;
END;
$$;

comment on function inv.update_stock_on_sale() is
  '0009 版本 + 可售量下限檢查。channel=online（錢已收）或 override_reservation=true（櫃檯放行，會寫告警）時不檢查。';

-- ---------------------------------------------------------------------------
-- 10. expire_unpaid_orders —— 加一句「刪掉保留列」
-- ---------------------------------------------------------------------------
-- ⚠️ create or replace 覆寫 0006 的同名函式。0006 檔案不動；**回傳的 TABLE 形狀
--    必須逐字相同**，否則 PostgreSQL 會擋下 CREATE OR REPLACE（改形狀要先 DROP，
--    而 DROP 會連帶影響已經在跑的 pg_cron / task endpoint）。
--
-- 相對 0006 的差異只有新增的第 4b 步。實體庫存從未因為保留而變動，所以這裡不需要
-- 任何「加回去」的動作 —— 刪掉那一列，可售量自動回來。
--
-- 鎖順序：0006 原本就先鎖 public.products；4b 才鎖 inv.products。全站唯一會在同一個
-- 交易裡持有兩張表的地方就是這裡，順序固定成 public → inv。
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
  -- 這裡沒有「加回去」的動作，因為從來沒有「扣下去」過。實體庫存在整段未付款期間
  -- 一動也沒動，inv.sales 一列也沒多。刪掉保留列，可售量就回來了。
  --
  -- 鎖 inv.products 是為了與 reserve / commit / release 共用同一條規矩；
  -- public.products 在第 2 步已經鎖過，順序固定為 public → inv。
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
  '0006 版本 + 第 4b 步：一併刪掉 stock_reservations。實體庫存與 inv.sales 全程未動，所以回收不需要任何補償寫入。';

-- ---------------------------------------------------------------------------
-- 11. 型錄與庫存不可以同時管同一件商品
-- ---------------------------------------------------------------------------
-- 有連結列的商品，public.products.stock 必須是 NULL。否則畫面上會有兩個庫存數字，
-- 而且會有兩個地方去扣它（atomic_deduct_stock 與 reserve/commit），最後兩邊都對不上。
--
-- 這是**跨表**的條件，CHECK constraint 做不到（CHECK 只能看同一列）。所以用 trigger。
-- 用 trigger 而不是在 repo 層擋，是因為 repo 層可以被繞過：Supabase dashboard、
-- 未來的 POS 後台、任何一支拿到 service_role 的腳本，都不會經過 repo。
create or replace function public.enforce_linked_product_stock_null()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stock is not null
     and exists (select 1 from public.product_inventory_links l where l.product_id = new.id)
  then
    raise exception
      'LINKED_PRODUCT_STOCK_MUST_BE_NULL:% —— 這件商品的庫存由進銷存管，public.products.stock 必須是 NULL', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists products_linked_stock_guard on public.products;
create trigger products_linked_stock_guard
  before insert or update on public.products
  for each row execute function public.enforce_linked_product_stock_null();

-- 另一半：不能把一件「已經有 stock」的商品連上進銷存。
-- 少了這一條，上面那個 trigger 是可以繞過去的（先設 stock 再建連結）。
create or replace function public.enforce_link_target_stock_null()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.products p where p.id = new.product_id and p.stock is not null
  ) then
    raise exception
      'CATALOG_STOCK_MUST_BE_NULL_BEFORE_LINK:% —— 請先把 public.products.stock 清成 NULL 再連結', new.product_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists product_inventory_links_stock_guard on public.product_inventory_links;
create trigger product_inventory_links_stock_guard
  before insert or update on public.product_inventory_links
  for each row execute function public.enforce_link_target_stock_null();

-- ---------------------------------------------------------------------------
-- 12. product_availability —— 前台唯一看得到的可售量
-- ---------------------------------------------------------------------------
-- ⚠️ 只暴露三個欄位。精確庫存是商業資訊：競爭對手可以靠它算出你的進貨節奏與週轉率，
--    而客人只需要知道「買不買得到」與「要不要快一點」。上限 10 之後，「還有 10」的
--    意思是「10 個以上」，而這對兩種讀者都夠了。
--
-- 這是 SECURITY DEFINER 語意的 view（security_invoker = false，PostgreSQL 預設）：
-- 底層的 inv.products / stock_reservations 以 view 擁有者（postgres）的權限讀取，
-- 所以 anon 讀得到這三個欄位，卻**完全打不到** inv —— anon 連 inv 的 USAGE 都沒有。
--
-- 刻意不呼叫 inv.resolve_stock_target()：函式的 EXECUTE 權限是對**當下使用者**檢查
-- 的，不會跟著 view 擁有者走，anon 會直接被擋。所以解析邏輯在這裡展開成 join。
-- （與第 5 節保持同一組規則：base 非空才乘 pack_size。）
--
-- where status = 'active' 是必要的：view 以擁有者身分讀底表，會繞過
-- products_select_public 那條 RLS policy，沒有這一行草稿商品的庫存也會外流。
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
    -- 活動／策旅：名額
    when p.product_type in ('event', 'journey') and p.capacity is not null then
      greatest(0, p.capacity - p.seats_taken)
    -- 純型錄商品：沿用 public.products.stock（0004 的既有路徑，行為不變）
    when p.stock is not null then
      greatest(0, p.stock)
    -- 不受庫存管：回報上限值，也就是「還很多」
    else 10
  end as units
) v
where p.status = 'active';

comment on view public.product_availability is
  '前台可售量。只三個欄位：精確庫存是商業資訊，上限 10 之後「10」的意思是「10 個以上」。有連結的商品讀 inv，沒有的沿用 public.products.stock。';

grant select on public.product_availability to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 13. 權限：四支新函式都是 SECURITY DEFINER，瀏覽器的金鑰一支都不能碰
-- ---------------------------------------------------------------------------
-- 與 0004 / 0006 / 0007 相同處理：PostgreSQL 建立函式時預設把 EXECUTE 授給 PUBLIC，
-- 所以「從 public revoke」才是真正生效的那一半，anon/authenticated 是保險。
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.reserve_inventory_stock(uuid, jsonb)',
    'public.commit_inventory_reservations(uuid, uuid)',
    'public.release_inventory_reservations(uuid)',
    'inv.resolve_stock_target(uuid)',
    'public.enforce_linked_product_stock_null()',
    'public.enforce_link_target_stock_null()'
  ]
  loop
    execute format('revoke execute on function %s from public', sig);
    execute format('revoke execute on function %s from anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end loop;
end $$;

-- 覆寫掉的兩支也重跑一次，避免 create or replace 之後權限漂移。
revoke execute on function public.expire_unpaid_orders(interval, integer) from public;
revoke execute on function public.expire_unpaid_orders(interval, integer) from anon, authenticated;
grant  execute on function public.expire_unpaid_orders(interval, integer) to service_role;

revoke execute on function inv.update_stock_on_sale() from public;
revoke execute on function inv.update_stock_on_sale() from anon, authenticated;
grant  execute on function inv.update_stock_on_sale() to service_role;

commit;
