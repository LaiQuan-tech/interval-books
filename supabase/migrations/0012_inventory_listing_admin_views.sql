-- 0012_inventory_listing_admin_views.sql —— 上架頁需要的兩個唯讀 view
--
-- ── 為什麼這不是 0011 的一部分 ──────────────────────────────────────────
-- 0011 已經套用到正式資料庫了，而「已套用的 migration 永不修改」。這兩個 view 是
-- 後台上架頁的支援設施，不是庫存單一真相的一部分，拆開反而更誠實：0011 拿掉之後
-- 網站會壞，這個檔案拿掉之後只是後台少一頁。
--
-- ── 為什麼需要 view，不能直接查 ─────────────────────────────────────────
-- inv 不在 PostgREST 的 db_schema 裡（0009 §0），所以 supabase-js 就算拿 service_role
-- 也**打不到** inv.*。這不是權限問題，是那 21 張表根本沒有被掛出來 —— 而那正是
-- inv.vendors 裡的身分證字號與銀行帳戶還安全的原因。
--
-- 於是後台要讀進銷存只有兩條路：SECURITY DEFINER 函式，或 public 底下的 view。
-- 這裡用 view，因為上架頁只讀不寫，而 view 能把「暴露哪幾欄」寫成一份看得見的清單。
--
-- ⚠️ 這兩個 view 是 security_invoker = false（PostgreSQL 預設），底表以擁有者權限
--    讀取。所以 grant 給誰就是全部的防線 —— **只給 service_role**，anon 與
--    authenticated 一個字都讀不到。這與 public.product_availability 不同：那個是
--    刻意開放給 anon 的，所以它只暴露三個不敏感的欄位。
--
-- 前一個 migration：0011_inventory_single_source.sql。既有 0001–0011 一律不動。

begin;

-- ---------------------------------------------------------------------------
-- 1. inv_listing_candidates —— 還沒上架、而且真的賣得動的品項
-- ---------------------------------------------------------------------------
-- 三個條件照抄進銷存自己對「現在可以賣」的定義，不重新發明：
--   is_active                    —— 沒有被停用
--   approval_status = 'approved' —— 過了簽核
--   stock_quantity > 0           —— 架上真的有
--
-- 再排除已經有連結的（一個進銷存品項只能上架成一個型錄商品，0011 §1 的 unique）。
--
-- 只暴露上架表單填得到的六個欄位。cost_price、vendor_id、pending_* 這些是內部
-- 成本與供應商資訊，後台這一頁沒有理由看到。
create or replace view public.inv_listing_candidates
with (security_invoker = false) as
select
  p.id             as inv_product_id,
  p.name           as name,
  p.selling_price  as selling_price,
  p.stock_quantity as stock_quantity,
  p.pack_size      as pack_size,
  p.barcode        as barcode
from inv.products p
where p.is_active
  and p.approval_status = 'approved'
  and p.stock_quantity > 0
  and not exists (
    select 1 from public.product_inventory_links l where l.inv_product_id = p.id
  );

comment on view public.inv_listing_candidates is
  '可上架的進銷存品項（is_active + approved + 有庫存 + 尚未上架）。只給 service_role，因為它讀的是 inv。';

-- ---------------------------------------------------------------------------
-- 2. inv_listed_products —— 已上架清單，兩側數字並排
-- ---------------------------------------------------------------------------
-- 後台唯一需要看到**精確**可售量的地方。前台看的是 product_availability，那個
-- 上限 10；店員要決定補不補貨，看不到真正的數字沒有意義。
--
-- available 這裡不做上限也不除以 units_per_sale：它是**進銷存單位**的可售量，
-- 也就是店員去架上數得出來的那個數字。型錄單位的換算是前台的事。
create or replace view public.inv_listed_products
with (security_invoker = false) as
select
  p.id                as product_id,
  p.slug              as slug,
  p.title             as title,
  p.price             as price,
  p.status            as status,
  l.inv_product_id    as inv_product_id,
  src.name            as inv_name,
  l.units_per_sale    as units_per_sale,
  tgt.stock_quantity  as stock_quantity,
  coalesce(res.qty, 0)                        as reserved,
  greatest(0, tgt.stock_quantity - coalesce(res.qty, 0)) as available
from public.product_inventory_links l
join public.products p   on p.id = l.product_id
join inv.products src    on src.id = l.inv_product_id
join inv.products tgt    on tgt.id = coalesce(src.base_product_id, src.id)
left join lateral (
  select sum(r.quantity)::integer as qty
    from public.stock_reservations r
   where r.inv_product_id = tgt.id
) res on true;

comment on view public.inv_listed_products is
  '已上架商品，型錄與進銷存的數字並排。available 是進銷存單位的精確可售量（後台才看得到，前台只看得到上限 10 的 product_availability）。';

-- ---------------------------------------------------------------------------
-- 3. 權限
-- ---------------------------------------------------------------------------
-- revoke 才是真正生效的那一半：view 建立時擁有者本來就有權限，而 PostgREST 會把
-- public 底下的每個 view 都掛出來。沒有 grant 的角色打過來就是 permission denied。
revoke all on public.inv_listing_candidates from anon, authenticated;
revoke all on public.inv_listed_products   from anon, authenticated;
grant select on public.inv_listing_candidates to service_role;
grant select on public.inv_listed_products   to service_role;

commit;
