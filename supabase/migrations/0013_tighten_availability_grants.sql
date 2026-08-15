-- 收緊 public.product_availability 對 anon / authenticated 的權限。
--
-- 0011 建這個 view 時只下了 `grant select`,沒有先 revoke。Supabase 對 public
-- schema 的新物件有預設全開的 ALTER DEFAULT PRIVILEGES,所以實際落地的是:
--
--   product_availability | anon          | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--   product_availability | authenticated | (同上)
--
-- 現在不可利用 —— 這個 view 是三張表的 join 加聚合子查詢,
-- information_schema.views 回報 is_updatable=NO / is_insertable_into=NO /
-- is_trigger_updatable=NO,Postgres 不允許透過它寫入,所以那些寫入權限是惰性的。
--
-- 那為什麼還要收?因為「惰性」是這個 view 目前的形狀給的,不是權限給的。
-- 哪天有人為了讓後台能就地編輯而加一個 INSTEAD OF trigger,is_trigger_updatable
-- 就變成 YES,同一組權限當場變成可寫,而且不會有任何東西提醒他。
-- 同一份 0011 建的另外三張表(stock_reservations / product_inventory_links /
-- stock_oversold_alerts)都有明確 revoke,對 anon 是零權限 —— 這支只是把 view
-- 拉回同一條線。
--
-- 順帶把預設權限本身關掉,避免之後在 public 建的新 view 重蹈覆轍。

revoke all on table public.product_availability from anon, authenticated;
grant select on table public.product_availability to anon, authenticated;

-- 驗證(執行後應為 anon/authenticated 各只有一列 SELECT):
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema='public' and table_name='product_availability'
--      and grantee in ('anon','authenticated') order by 1,2;
