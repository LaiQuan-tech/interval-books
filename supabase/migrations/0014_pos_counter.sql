-- 0014_pos_counter.sql —— 把櫃檯搬進來
--
-- 0011 讓網站賣進銷存的實體庫存；這一份讓**門市**也走進同一條路，並且收掉
-- 0011 留下的兩個缺口（FIFO 沒人呼叫、賣超告警沒有出口）。
--
-- ── 這個檔案做四件事 ──────────────────────────────────────────────────────
--   1. inv.sales 的 BEFORE INSERT 補上 FIFO 成本分攤（缺口 2）
--   2. stock_oversold_alerts 加上「誰在什麼時候處理掉的」（缺口 1）
--   3. public.pos_checkout() —— 櫃檯結帳的唯一入口，整車一個交易
--   4. 四個唯讀 view，讓後台讀得到 inv.*（理由同 0012：inv 不在 PostgREST 上）
--
-- 前一個 migration：0013_tighten_availability_grants.sql。既有 0001–0013 一律不動。

begin;

-- ---------------------------------------------------------------------------
-- 1. FIFO 成本分攤 —— 從「前端記得呼叫」改成「插入時一定發生」
-- ---------------------------------------------------------------------------
-- inv.allocate_fifo_cost() 從 0009 搬進來之後從來沒有被呼叫過，所以
-- commit_inventory_reservations() 寫的每一列 inv.sales 的 cost_price 都是 NULL：
-- 網站賣掉的東西沒有成本，毛利報表少一塊，供應商對帳也對不起來。
--
-- ── 為什麼是 trigger，不是「在 commit 裡呼叫」也不是「排程補算」 ──────────
-- allocate_fifo_cost() **不是純函式**：它會 `UPDATE inv.purchases SET
-- remaining_quantity = remaining_quantity - take`。呼叫兩次就扣兩次，而扣兩次的
-- 後果不是「數字看起來怪」，是毛利與供應商對帳從此都錯，而且沒有任何地方會報錯。
-- 所以唯一真正要保證的事情是**每一列 inv.sales 恰好觸發一次**。
--
--   排程補算  → 要自己記「這列算過了嗎」。cost_price IS NULL 看起來像個好標記，
--               但一列成本真的是 0 的商品也長這樣，而且補算與新銷售之間有競態。
--               它還會讓 cost_price 在幾分鐘內是 NULL —— 那段時間的報表是錯的。
--   在 commit 裡呼叫 → 只蓋住線上那一半。POS 端就得另外呼叫一次，兩份實作、
--                      兩個會漂移的地方，而且 POS 若走前端呼叫就回到來源系統的
--                      老問題：RPC 成功、insert 失敗，remaining_quantity 憑空消失。
--   BEFORE INSERT trigger → 一列插入 = 觸發一次，這是 PostgreSQL 給的保證，
--                           不需要任何簿記。而且它跟 sales 在同一個交易裡：
--                           後面的 on_sale_insert 若擋下這筆（庫存不足），
--                           purchases 的扣減一起回捲。
--
-- ── 還有一個更硬的理由：既有的 DELETE trigger 已經假設它發生過了 ──────────
-- 0009 的 rollback_fifo_on_sale_delete（BEFORE DELETE）會把 remaining_quantity
-- **加回去**。今天刪掉一列 channel='online' 的銷售，會回補一份從來沒有被扣過的
-- 數量 —— 那是一條現在就在資料庫裡的資料破壞路徑。補上這個 trigger 之後，
-- INSERT 扣、DELETE 補，兩邊才對稱。
--
-- ── 冪等的守門在 cost_price IS NULL ────────────────────────────────────────
-- 呼叫端自己算好成本傳進來（來源進銷存系統就是這樣做的）時，這裡不覆寫也不重扣。
-- 所以這個 trigger 對「舊系統照舊寫入」是完全透明的。
create or replace function inv.allocate_fifo_on_sale()
returns trigger
language plpgsql
security definer
set search_path to 'inv', 'public'
as $$
BEGIN
  -- 已經有成本 = 呼叫端自己分攤過了。再叫一次就是扣第二次。
  IF NEW.cost_price IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 與 rollback_fifo_cost() 的第一道 guard 逐字對齊：二手書沒有進貨批次，
  -- product_id 為空的列（歷史資料）也沒有可以扣的東西。
  IF NEW.product_id IS NULL OR NEW.is_secondhand = true THEN
    RETURN NEW;
  END IF;

  -- allocate_fifo_cost 內建 base_product_id × pack_size 的解析，與
  -- update_stock_on_sale() 一致，所以這裡傳 NEW.product_id 與 NEW.quantity
  -- 就好，不要在外面先換算一次（換算兩次就是乘兩次 pack_size）。
  NEW.cost_price := inv.allocate_fifo_cost(NEW.product_id, NEW.user_id, NEW.quantity);

  RETURN NEW;
END;
$$;

comment on function inv.allocate_fifo_on_sale() is
  'BEFORE INSERT ON inv.sales：cost_price 為 NULL 時跑一次 FIFO 分攤。一列一次，與 BEFORE DELETE 的 rollback_fifo_cost() 對稱。';

drop trigger if exists allocate_fifo_before_sale_insert on inv.sales;
create trigger allocate_fifo_before_sale_insert
  before insert on inv.sales
  for each row execute function inv.allocate_fifo_on_sale();

revoke execute on function inv.allocate_fifo_on_sale() from public;
revoke execute on function inv.allocate_fifo_on_sale() from anon, authenticated;
grant  execute on function inv.allocate_fifo_on_sale() to service_role;

-- ---------------------------------------------------------------------------
-- 2. stock_oversold_alerts —— 從「留痕」變成「有人處理」
-- ---------------------------------------------------------------------------
-- 0011 建了這張表但沒有出口：告警寫進去之後沒有任何地方看得到它，也沒有辦法
-- 說「這筆處理完了」。三個欄位就夠 —— 誰、什麼時候、做了什麼。
--
-- 沒有 resolved boolean：`resolved_at is not null` 已經是答案，多一個 boolean
-- 就多一個會跟時間戳講不一樣的故事的欄位。
alter table public.stock_oversold_alerts
  add column if not exists resolved_at     timestamptz,
  add column if not exists resolved_by     uuid references auth.users (id) on delete set null,
  add column if not exists resolution_note text;

comment on column public.stock_oversold_alerts.resolved_at is
  '處理完成的時間。NULL = 還沒有人處理。這一欄就是狀態，不另外放 boolean。';
comment on column public.stock_oversold_alerts.resolved_by is
  '處理的人。on delete set null：人可以離職，「這筆被處理過」不能因此變回未處理。';
comment on column public.stock_oversold_alerts.resolution_note is
  '處理說明（盤點補上／客人取消／已向供應商叫貨…）。賣超的原因每次都不一樣，強制分類只會讓大家都選「其他」。';

-- 未處理的排前面、同狀態按時間新到舊 —— 就是告警頁預設的排序。
create index if not exists stock_oversold_alerts_open_idx
  on public.stock_oversold_alerts (created_at desc) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- 3. pos_checkout —— 櫃檯結帳，整車一個交易
-- ---------------------------------------------------------------------------
-- 來源進銷存系統結帳一車是「前端 for 迴圈，每件各一次 rpc + 一次 insert」。
-- 中途失敗就留下半套資料，而且沒有補償邏輯（FIFO 已扣、銷售沒寫）。這裡整車
-- 收進一個函式，也就是一個交易：要嘛整車成立，要嘛什麼都沒發生。
--
-- p_items: [{"inv_product_id": "<uuid>", "quantity": 2, "unit_price": 350}, …]
--   unit_price 是**成交價**，不是定價 —— 櫃檯折扣在這個專案就是改這個數字
--   （來源系統也是，sales 表沒有 discount 欄位）。定價另外記在 notes 裡。
--
-- 回傳 jsonb：
--   {"sale_ids": [...], "total_amount": n, "total_cost": n,
--    "oversold": [{"inv_product_id": …, "shortfall": n}]}
--
-- ── 鎖的順序是刻意的 ──────────────────────────────────────────────────────
-- 先把整車要扣的目標列**依 uuid 排序**一次鎖完，再逐件 insert。理由是死鎖：
-- 兩個櫃檯同時賣 A+B 與 B+A，各自照購物車順序鎖就會互等。排序之後所有交易的
-- 取鎖順序一致，這種死鎖在結構上不可能發生。
--
-- 鎖完才算可售量，所以「檢查」與「扣減」之間沒有窗口 —— 這裡的檢查是為了給出
-- 一句看得懂的錯誤（哪一件不夠、差幾個），真正的下限守門仍然在
-- inv.update_stock_on_sale() 那個 trigger 上（前端有好幾個入口，但都會經過它）。
create or replace function public.pos_checkout(
  p_user_id              uuid,
  p_items                jsonb,
  p_payment_method_id    uuid    default null,
  p_sale_date            date    default current_date,
  p_notes                text    default null,
  p_override_reservation boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_item        jsonb;
  v_product     record;
  v_target      record;
  v_sale_id     uuid;
  v_sale_ids    uuid[] := '{}';
  v_total_amt   numeric := 0;
  v_total_cost  numeric := 0;
  v_qty         integer;
  v_price       numeric;
  v_cost        numeric;
  v_available   integer;
  v_need        integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'POS_NO_OPERATOR: 結帳必須記錄操作人員';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'POS_EMPTY_CART: 購物車是空的';
  END IF;

  -- ---- 第一遍：驗每一件，並把要扣的目標列依 uuid 排序鎖起來 ---------------
  FOR v_target IN
    SELECT t.target_id, sum(t.need)::integer AS need
      FROM (
        SELECT r.target_id,
               r.multiplier * (i->>'quantity')::integer AS need
          FROM jsonb_array_elements(p_items) AS i
          CROSS JOIN LATERAL inv.resolve_stock_target((i->>'inv_product_id')::uuid) AS r
      ) t
     GROUP BY t.target_id
     ORDER BY t.target_id            -- ← 全域一致的取鎖順序，見上面
  LOOP
    SELECT p.stock_quantity
             - coalesce((SELECT sum(s.quantity)::integer
                           FROM public.stock_reservations s
                          WHERE s.inv_product_id = p.id), 0)
      INTO v_available
      FROM inv.products p
     WHERE p.id = v_target.target_id
       FOR UPDATE;

    v_need := v_target.need;

    IF NOT p_override_reservation AND coalesce(v_available, 0) < v_need THEN
      -- 帶著品名丟出去。'INSUFFICIENT_STOCK:<uuid>' 對店員沒有意義，而這句話
      -- 是他在櫃檯唯一會看到的東西。
      RAISE EXCEPTION 'POS_INSUFFICIENT_STOCK: 「%」可售 % 件，這一車需要 % 件',
        (SELECT name FROM inv.products WHERE id = v_target.target_id),
        greatest(coalesce(v_available, 0), 0), v_need
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- ---- 第二遍：逐件寫 inv.sales，讓既有的兩個 trigger 做事 ----------------
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty   := (v_item->>'quantity')::integer;
    v_price := (v_item->>'unit_price')::numeric;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'POS_BAD_QUANTITY: 數量必須大於 0';
    END IF;
    -- 來源系統的 parseFloat('') 會讓 NaN 直接寫進 unit_price。這裡擋掉。
    IF v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION 'POS_BAD_PRICE: 單價不能是空的或負數';
    END IF;

    SELECT p.id, p.name, p.product_type, p.is_active, p.approval_status
      INTO v_product
      FROM inv.products p
     WHERE p.id = (v_item->>'inv_product_id')::uuid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'POS_UNKNOWN_PRODUCT: 找不到商品 %', v_item->>'inv_product_id';
    END IF;

    -- 來源系統的 approvedProducts 是死碼（算出來沒人用），所以未審核、已停用的
    -- 商品掃得出來也賣得掉。這裡把那三個條件擋在資料庫，前端漏擋也沒關係。
    IF NOT v_product.is_active THEN
      RAISE EXCEPTION 'POS_PRODUCT_INACTIVE: 「%」已停用，不能販售', v_product.name;
    END IF;
    IF v_product.approval_status <> 'approved' THEN
      RAISE EXCEPTION 'POS_PRODUCT_UNAPPROVED: 「%」還沒通過審核，不能販售', v_product.name;
    END IF;
    IF v_product.product_type = 'rental' THEN
      RAISE EXCEPTION 'POS_PRODUCT_RENTAL: 「%」是租借品，不能販售', v_product.name;
    END IF;

    INSERT INTO inv.sales (
      user_id, product_id, sale_date, quantity, unit_price, amount,
      payment_method_id, notes, channel, override_reservation
    ) VALUES (
      p_user_id, v_product.id, p_sale_date, v_qty, v_price, v_qty * v_price,
      p_payment_method_id, p_notes, 'pos', coalesce(p_override_reservation, false)
    )
    RETURNING id, cost_price INTO v_sale_id, v_cost;

    v_sale_ids   := v_sale_ids || v_sale_id;
    v_total_amt  := v_total_amt + v_qty * v_price;
    v_total_cost := v_total_cost + coalesce(v_cost, 0) * v_qty;
  END LOOP;

  RETURN jsonb_build_object(
    'sale_ids',     to_jsonb(v_sale_ids),
    'total_amount', v_total_amt,
    'total_cost',   v_total_cost,
    -- 逃生門走過的話，trigger 已經在這個交易裡寫好告警了。撈回來讓 UI 當場
    -- 告訴店員「你剛剛賣超了，這件事被記下來了」，而不是等他哪天打開告警頁。
    'oversold', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'inv_product_id', a.inv_product_id,
               'product_name',   (SELECT name FROM inv.products WHERE id = a.inv_product_id),
               'shortfall',      a.shortfall))
        FROM public.stock_oversold_alerts a
       WHERE a.sale_id = ANY (v_sale_ids)
    ), '[]'::jsonb)
  );
END;
$$;

comment on function public.pos_checkout(uuid, jsonb, uuid, date, text, boolean) is
  '櫃檯結帳。整車一個交易（來源系統是前端 for 迴圈，中途失敗會留下已扣 FIFO 但沒有銷售紀錄的孤兒）。依 uuid 排序取鎖，避免兩個櫃檯互等。';

revoke execute on function public.pos_checkout(uuid, jsonb, uuid, date, text, boolean) from public;
revoke execute on function public.pos_checkout(uuid, jsonb, uuid, date, text, boolean) from anon, authenticated;
grant  execute on function public.pos_checkout(uuid, jsonb, uuid, date, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 4. 四個唯讀 view
-- ---------------------------------------------------------------------------
-- 理由與 0012 完全相同：inv 不在 PostgREST 的 db_schema 裡，所以 service_role 的
-- supabase-js client 打不到 inv.*。要讀就得開一扇寫得出清單的窗。
--
-- ⚠️ 全部 security_invoker = false，所以 grant 給誰就是全部的防線。只給
--    service_role —— 而 service_role 只在 src/server/repos/** 出現，那些檔案的
--    每一個呼叫端都先過了 staffFnMiddleware 或 adminFnMiddleware。

-- 4a. inv_pos_products —— 櫃檯掃得到／搜得到的商品
--
-- 與 0012 的 inv_listing_candidates 不同，這裡**不排除已上架的**：一本書在網站
-- 上賣，不代表它不能在櫃檯賣，那正是這一期要證明的事。也**不要求 stock > 0**，
-- 因為賣超逃生門要看得到那些歸零的品項。
--
-- available 換算成**銷售單位**（外帶茶餅賣 1 個 = 從母品項扣 pack_size 個），
-- 所以 UI 的「還可以賣幾件」直接讀這一欄，不用在前端再乘一次。
create or replace view public.inv_pos_products
with (security_invoker = false) as
select
  p.id                as inv_product_id,
  p.name              as name,
  p.barcode           as barcode,
  p.issue_number      as issue_number,
  p.series            as series,
  p.product_type      as product_type,
  p.selling_price     as selling_price,
  p.base_product_id   as base_product_id,
  r.target_id         as stock_target_id,
  tgt.name            as stock_target_name,
  r.multiplier        as units_per_item,
  tgt.stock_quantity  as stock_quantity,
  coalesce(res.qty, 0) as reserved,
  greatest(0, (tgt.stock_quantity - coalesce(res.qty, 0)) / r.multiplier)::integer as available
from inv.products p
cross join lateral inv.resolve_stock_target(p.id) r
join inv.products tgt on tgt.id = r.target_id
left join lateral (
  select sum(s.quantity)::integer as qty
    from public.stock_reservations s
   where s.inv_product_id = r.target_id
) res on true
where p.is_active
  and p.approval_status = 'approved'
  and p.product_type <> 'rental';   -- 來源系統的 canBeSold()

comment on view public.inv_pos_products is
  '櫃檯賣得動的品項（is_active + approved + 非租借）。available 是銷售單位的可售量，已除過 pack_size。只給 service_role。';

-- 4b. inv_pos_payment_methods —— 付款方式
create or replace view public.inv_pos_payment_methods
with (security_invoker = false) as
select
  m.id            as payment_method_id,
  m.name          as name,
  m.is_default    as is_default,
  m.display_order as display_order,
  m.fee_category  as fee_category
from inv.payment_methods m
where m.is_active;

comment on view public.inv_pos_payment_methods is
  '啟用中的付款方式。這不是列舉，是店家自己維護的一張表（現金／刷卡／華山簽單…）。只給 service_role。';

-- 4c. inv_pos_sales —— 銷售紀錄
--
-- 毛利在這裡算，不在前端。來源系統把同一段公式抄了五份（列表、手機版、明細、
-- Excel、統計卡），其中兩處的營收口徑還不一樣（unit_price×quantity vs amount）。
-- 一個 view 一份定義。
--
-- cost_price 為 NULL 時毛利也是 NULL，不是 0 —— 「不知道」跟「零」是兩件事，
-- 而搬遷前的 45 列就是不知道。
create or replace view public.inv_pos_sales
with (security_invoker = false) as
select
  s.id                  as sale_id,
  s.sale_date           as sale_date,
  s.created_at          as created_at,
  s.channel             as channel,
  s.override_reservation as override_reservation,
  s.web_order_id        as web_order_id,
  s.quantity            as quantity,
  s.unit_price          as unit_price,
  s.amount              as amount,
  s.cost_price          as cost_price,
  case when s.cost_price is null then null
       else s.amount - s.cost_price * s.quantity end as gross_profit,
  s.is_secondhand       as is_secondhand,
  s.item_name           as item_name,
  s.notes               as notes,
  s.combo_set_id        as combo_set_id,
  s.combo_sale_group    as combo_sale_group,
  s.is_reconciled       as is_reconciled,
  s.reconciled_at       as reconciled_at,
  s.product_id          as inv_product_id,
  coalesce(p.name, s.item_name) as product_name,
  p.issue_number        as issue_number,
  p.series              as series,
  p.product_type        as product_type,
  s.payment_method_id   as payment_method_id,
  m.name                as payment_method_name,
  s.user_id             as user_id,
  coalesce(prof.name, prof.email) as operator_name
from inv.sales s
left join inv.products p        on p.id = s.product_id
left join inv.payment_methods m on m.id = s.payment_method_id
left join inv.profiles prof     on prof.user_id = s.user_id;

comment on view public.inv_pos_sales is
  '銷售紀錄（門市＋網站）。毛利在這裡算一次，不在前端算五次。cost_price 為 NULL 時毛利是 NULL 而不是 0。只給 service_role。';

-- 4d. inv_stock_alerts —— 賣超告警，帶品名
--
-- 表在 public，service_role 直接讀得到；需要這個 view 的唯一理由是品名在 inv，
-- PostgREST join 不過去。
create or replace view public.inv_stock_alerts
with (security_invoker = false) as
select
  a.id              as alert_id,
  a.created_at      as created_at,
  a.source          as source,
  a.shortfall       as shortfall,
  a.inv_product_id  as inv_product_id,
  p.name            as product_name,
  p.stock_quantity  as current_stock,
  a.sale_id         as sale_id,
  a.order_id        as order_id,
  o.status          as order_status,
  o.customer_name   as customer_name,
  a.resolved_at     as resolved_at,
  a.resolved_by     as resolved_by,
  a.resolution_note as resolution_note,
  res.email         as resolved_by_email
from public.stock_oversold_alerts a
join inv.products p          on p.id = a.inv_product_id
left join public.orders o    on o.id = a.order_id
left join public.profiles res on res.id = a.resolved_by;

comment on view public.inv_stock_alerts is
  '賣超告警＋品名＋目前庫存＋（線上的話）是哪張訂單。只給 service_role。';

-- ---------------------------------------------------------------------------
-- 5. 權限
-- ---------------------------------------------------------------------------
-- ⚠️ revoke 才是真正生效的那一半。Supabase 對 public schema 有 ALTER DEFAULT
--    PRIVILEGES，新建的 view 一出生就對 anon/authenticated 是 ALL —— 只下
--    `grant select to service_role` 會留下那個 ALL。0013 就是在修這個坑，
--    這裡從一開始就先 revoke。
revoke all on public.inv_pos_products        from anon, authenticated;
revoke all on public.inv_pos_payment_methods from anon, authenticated;
revoke all on public.inv_pos_sales           from anon, authenticated;
revoke all on public.inv_stock_alerts        from anon, authenticated;

grant select on public.inv_pos_products        to service_role;
grant select on public.inv_pos_payment_methods to service_role;
grant select on public.inv_pos_sales           to service_role;
grant select on public.inv_stock_alerts        to service_role;

commit;
