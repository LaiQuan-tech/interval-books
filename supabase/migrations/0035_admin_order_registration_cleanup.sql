-- 0035_admin_order_registration_cleanup.sql —— 後台終於有地方可以刪資料了
--
-- 前一支 migration：0034_transfer_payment.sql。既有 0001–0034 一律不動——這裡只
-- `create or replace` 三支全新的函式、`alter table … add column if not exists`
-- 一個新欄位，不改任何既有函式的簽章或 RETURNS TABLE 形狀。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §0  在補哪個洞
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 後台到 0034 為止沒有任何一個「移除」的按鈕：訂單清不掉、報名名單改不了。測試
-- 訂單、客人臨時說不來的報名，唯一的解法是店家自己開 Supabase Dashboard 手改
-- ——而手改最容易漏掉的正是「把名額還回去」，因為 dashboard 的 table editor 不會
-- 幫你跑 release_session_seat()。這一支就是把那條路徑收進資料庫本身。
--
-- 三個決定（已經確認，不是這支 migration 的討論範圍）：
--
--   1. 已付款的訂單**不刪**，改成「封存」——列表隱藏、紀錄全留、可還原。
--   2. 未付款／已取消的訂單**真的刪掉**。
--   3. 報名名單一律可刪、名額自動還回去（包含已付款的名單列）。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §1  刪訂單會撞到的三個東西
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1.1 名額不會自己跟著少 ------------------------------------------------------
--
-- `event_registrations` 上一個 trigger 都沒有（0020 全篇找不到 `create trigger`
-- 掛在這張表上）。`event_sessions.seats_taken` 的欄位註解（0020:219-220）寫死：
-- 只由 reserve_session_seat() / release_session_seat() / expire_unpaid_orders()
-- 維護。直接 `delete from orders` 讓 event_registrations 跟著 cascade 消失，
-- seats_taken **不會**自己減——位子被算著卻沒人報名，畫面上看不出來，只會慢慢
-- 變成「明明沒人卻顯示額滿」。
--
-- 1.2 刪訂單會連帶刪掉 payments 與 invoices -----------------------------------
--
-- 指向 orders 的外鍵有八個是 on delete cascade：payments、invoices、order_items、
-- order_addresses、event_registrations（0020:280）、logistics、stock_reservations
-- （0011:103）、order_post_payment_log。「刪訂單」不是刪一列，是把付款與發票紀錄
-- 一起消掉——這正是已付款訂單改走「封存」而不是「刪除」的理由。
--
-- 1.3 inv.sales.web_order_id 是 NO ACTION，會擋住刪除 ------------------------
--
-- 已付款訂單經 commitInventoryForOrder()（src/server/repos/orders.ts）寫進
-- inv.sales，那個外鍵（0011:176）沒寫 on delete，預設就是 NO ACTION，所以這種
-- 訂單在資料庫層天生刪不掉，會拋 FK 違規。這是天然護欄，但不能讓使用者看到裸的
-- FK 錯誤——§3 的 admin_delete_order() 自己先查一次，回一個可讀的理由碼。
--
-- ⚠️ 這一條**不是** payment_status = 'paid' 檢查的重複。付款成功之後 payment_status
--    還可能被改成 'refunded'（見 orders_payment_status_check 的四個值），但
--    inv.sales 那一列不會因為退款而被清掉——所以「先擋 paid，再擋
--    has_inventory_sale」抓的是兩個不同時間點的訂單，兩條檢查都要留著，順序不能
--    只留一條。
--
-- 1.4 順序錯了名額就漏掉 ------------------------------------------------------
--
-- 0020:115-120 的檔頭已經寫過這個警告：release_session_seat() 一定要在刪訂單
-- **之前**呼叫——直接刪訂單的話 registrations 會跟著消失，但 seats_taken 不會
-- 自己減。src/server/repos/orders.ts 結帳失敗回滾的私有 deleteOrder() 就是照這個
-- 順序寫的（release → delete），而且 scripts/event-registration-selftest.mjs 有
-- 一條斷言在守那個順序（releaseIdx < deleteIdx）。§3 的 admin_delete_order() 抄
-- 同一個順序：public.products（型錄庫存，見 §1.5）→ inv.products
-- （release_inventory_reservations，鎖順序同 0020 §4）→ event_sessions
-- （release_session_seat，逐 order_item 呼叫）→ 最後才刪訂單列。
--
-- 1.5 🔴 這支自己多發現的第五個坑：純型錄庫存（public.products.stock）也會漏 ----
--
-- 上面四點是任務書已經核對過正式庫的已知事實，直接採用、沒有重新調查。這一條是
-- 讀 src/server/repos/orders.ts 檔頭與 expire_unpaid_orders()（0011/0020/0034）
-- 之後另外發現的、同一個形狀的坑，任務書沒有提到，這裡老實寫下來：
--
-- goods/book 兩類商品如果**沒有**連到 inv（product_inventory_links 沒有那一列），
-- 走的是 0004 的 atomic_deduct_stock()：下單當下直接扣 `public.products.stock`，
-- 不經過 stock_reservations、release_inventory_reservations() 完全碰不到它。
-- 這批庫存唯一的「還回去」路徑是 expire_unpaid_orders() 第 3 步（`stock = stock +
-- qty`）——如果 admin_delete_order() 對一張**還是 pending、還沒過期**的訂單只做
-- release_session_seat / release_inventory_reservations 就刪掉，這批型錄庫存會
-- 跟座位一樣，永久少一份、畫面上看不出來。
--
-- ⚠️ 但這個還原**不能對所有訂單無條件做**：一張 status = 'cancelled' 的訂單，
--    代表它已經被 expire_unpaid_orders() 處理過一次，型錄庫存**已經**還回去了
--    （這個 repo 裡只有那一支函式會把 status 改成 'cancelled'，見本檔案 §1.6 的
--    確認）。此時如果再做一次 `stock = stock + qty`，就是把同一批貨算兩次——
--    比完全不還更糟，因為它是靜默發生的正向錯誤（庫存無中生有），沒有任何約束
--    會擋。所以 §3 用 `v_order.status = 'pending'` 當閘門：只有還沒過期的訂單
--    才補這一步，release_session_seat() / release_inventory_reservations() 不受
--    這個閘門限制，因為兩者本身是 DELETE…RETURNING 當 claim，天生冪等，對一張
--    已經被回收過的訂單再呼叫一次自然回 0，不會重複扣。
--
-- 1.6 確認：orders.status 改成 'cancelled' 只有一個入口 -----------------------
--
-- 全 repo 搜尋 `status.*=.*'cancelled'`：0006 / 0011 / 0020 / 0034 四份都是
-- expire_unpaid_orders() 自己的四個版本（同一支函式逐期改寫），没有其他任何
-- migration 或 src/server/**/*.ts 會把 orders.status 寫成 'cancelled'。§1.5 那個
-- 「只在 pending 時還原型錄庫存」的閘門建立在這個事實上——如果未來有第二個地方
-- 也會把訂單改成 cancelled 卻不還庫存，這個閘門就會漏補；到時候要嘛讓那個新入口
-- 也還庫存，要嘛把這裡的判斷改成讀一個明確的「型錄庫存還沒還」旗標。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §2  三支函式的回傳形狀，照抄 0034 §5 admin_mark_order_paid() 那一份
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `returns table (布林, reason text, …)`，reason 是具名字串而不是共用一個
-- 'ERROR'，理由與 admin_mark_order_paid() 相同：呼叫端（後台畫面）要能對每一種
-- 拒絕理由講不同的話，而不是「失敗，請稍後再試」。三支都：
--
--   · security definer + set search_path = ''（0034 §5 的做法，全部用
--     public. / inv. 明確寫死 schema，不依賴 search_path）
--   · 先對目標列 `for update` 建立序列化點，理由與 admin_mark_order_paid() 相同：
--     同一張訂單／同一筆報名被連點兩下，第二次必須在第一次 commit 之後才讀到
--     新的事實。
--   · revoke from public / anon / authenticated，只 grant service_role
--     （§5 的 do block）。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §3  admin_delete_order —— 未付款／已取消的訂單，真的刪
-- ═══════════════════════════════════════════════════════════════════════════

begin;

alter table public.orders
  add column if not exists archived_at timestamptz;

comment on column public.orders.archived_at is
  '後台「封存」用（0035）。只是顯示狀態——不動名額、不動任何紀錄，可隨時用 admin_archive_order() 復原。已付款訂單刪不掉（§1.2／§1.3），封存是它們唯一的「從列表移掉」路徑。';

-- 預設列表（scope='all' 與 'transfer_pending'）都是「不含已封存」，且依
-- created_at 排序——與 0034 §2 的 orders_remittance_pending_idx 同一個理由：
-- 部分索引只蓋「還沒被封存」這個子集，而多數訂單很快就會被封存或本來就沒封存過，
-- 索引因此保持小。
create index if not exists orders_not_archived_idx
  on public.orders (created_at desc)
  where archived_at is null;

comment on index public.orders_not_archived_idx is
  '後台訂單列表預設看「未封存」用（0035）。部分索引——已封存的訂單天生是全表的小子集。';

create or replace function public.admin_delete_order(
  p_order_id uuid,
  p_actor_id uuid
)
returns table (
  deleted  boolean,
  reason   text,
  order_no text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_item  record;
begin
  if p_order_id is null then
    raise exception 'NULL_ORDER_ID';
  end if;

  -- ---- 閘門 1：訂單列鎖（同 admin_mark_order_paid，序列化點） --------------
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    return query select false, 'order_not_found', null::text;
    return;
  end if;

  -- ---- 閘門 2：已付款的不准刪，改用 admin_archive_order() ------------------
  if v_order.payment_status = 'paid' then
    return query select false, 'order_is_paid', v_order.order_no;
    return;
  end if;

  -- ---- 閘門 3：已經進了 inv.sales 的不准刪（§1.3／§1.6 的退款情境）--------
  -- 先查再刪，不讓 NO ACTION 的外鍵把裸的 FK 違規丟給呼叫端。
  if exists (select 1 from inv.sales s where s.web_order_id = p_order_id) then
    return query select false, 'has_inventory_sale', v_order.order_no;
    return;
  end if;

  -- ---- 通過，開始還原（鎖順序 public.products → inv.products →
  --      public.event_sessions，同 0020 §4） ---------------------------------

  -- §1.5／§1.6：型錄庫存只在訂單還是 pending（還沒被 expire_unpaid_orders()
  -- 處理過）時才補還，避免對已經還過一次的 cancelled 訂單重複入帳。
  if v_order.status = 'pending' then
    perform 1
      from public.products p
     where p.id in (
             select oi.product_id
               from public.order_items oi
              where oi.order_id = p_order_id
                and oi.product_id is not null
           )
     order by p.id
       for update;

    update public.products p
       set stock = p.stock + agg.qty
      from (
        select oi.product_id                    as pid,
               sum(oi.quantity)::integer         as qty
          from public.order_items oi
         where oi.order_id = p_order_id
           and oi.product_id is not null
           and oi.product_type in ('goods', 'book')
         group by oi.product_id
      ) agg
     where p.id = agg.pid
       and p.stock is not null;
  end if;

  -- release_inventory_reservations() 與下面的 release_session_seat() 都是
  -- DELETE…RETURNING 當冪等 claim（0011 §8／0020 §8）：對一張已經被
  -- expire_unpaid_orders() 處理過的訂單再呼叫一次，自然回 0，不受 §1.5 那個
  -- pending 閘門限制。
  perform public.release_inventory_reservations(p_order_id);

  -- ⚠️ 對**每一個** order_item 呼叫，不只 event/journey 的——release_session_seat()
  -- 對沒有報名紀錄的 order_item 是 no-op（0020:620-622：v_session is null → 回
  -- 0），比在這裡自己判斷 product_type 更不容易漏掉一種商品型態。
  for v_item in select id from public.order_items where order_id = p_order_id loop
    perform public.release_session_seat(v_item.id);
  end loop;

  -- 最後才刪。order_items／order_addresses／payments／invoices／logistics／
  -- stock_reservations／event_registrations／order_post_payment_log 這八張表
  -- 全部 on delete cascade（§1.2），此時該還的都已經還完了。
  delete from public.orders where id = p_order_id;

  -- 這張訂單與它的子表接下來都不存在了，資料庫裡沒有第二個地方能留住「誰刪的」；
  -- raise log 至少讓它進 Postgres 的伺服器 log，而不是完全無痕（不是可查詢的稽核
  -- 表——這一期沒有新增那樣的表，見任務交付回報）。
  raise log 'admin_delete_order: % (%) deleted by %', v_order.order_no, p_order_id, p_actor_id;

  return query select true, 'deleted', v_order.order_no;
end;
$$;

comment on function public.admin_delete_order(uuid, uuid) is
  '刪除未付款／已取消的訂單（0035）。已付款回 order_is_paid，已進 inv.sales 回 has_inventory_sale——兩條檢查都在真的 DELETE 之前，不讓 FK 違規冒出來。刪除前照 0020 §4 的鎖順序還原型錄庫存／進銷存保留／場次名額。reason ∈ deleted | order_not_found | order_is_paid | has_inventory_sale。';

-- ═══════════════════════════════════════════════════════════════════════════
-- §4  admin_archive_order —— 已付款訂單的「刪除」替身
-- ═══════════════════════════════════════════════════════════════════════════
-- 純粹的顯示狀態：不動名額、不動 payments/invoices、不檢查 payment_status。任何
-- 存在的訂單都可以被封存或取消封存，可逆——這是它與 admin_delete_order() 最本質
-- 的差異，也是已付款訂單只能走這條路的理由。
--
-- p_archived = true 用 coalesce(archived_at, now())，不是無條件 now()：對一張
-- 已經封存過的訂單再封存一次，保留**第一次**封存的時間，而不是每點一下就往後推。
create or replace function public.admin_archive_order(
  p_order_id  uuid,
  p_actor_id  uuid,
  p_archived  boolean
)
returns table (
  updated  boolean,
  reason   text,
  order_no text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  if p_order_id is null then
    raise exception 'NULL_ORDER_ID';
  end if;
  if p_archived is null then
    raise exception 'NULL_ARCHIVED_FLAG';
  end if;

  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    return query select false, 'order_not_found', null::text;
    return;
  end if;

  update public.orders o
     set archived_at = case when p_archived then coalesce(o.archived_at, now()) else null end
   where o.id = p_order_id;

  return query
    select true,
           case when p_archived then 'archived' else 'unarchived' end,
           v_order.order_no;
end;
$$;

comment on function public.admin_archive_order(uuid, uuid, boolean) is
  '設／清 orders.archived_at（0035）。不動名額、不動任何紀錄——純顯示狀態，隨時可用相反的 p_archived 值復原。p_actor_id 目前只接受不落地（見 admin_delete_order 的同一段說明）；reason ∈ archived | unarchived | order_not_found。';

-- ═══════════════════════════════════════════════════════════════════════════
-- §5  admin_delete_registration —— 名單單筆移除，名額自動還
-- ═══════════════════════════════════════════════════════════════════════════
-- 形狀照抄 release_session_seat()（0020:601-649）：鎖場次（for no key update，
-- 理由同 0020 §2 的第一個 ⚠️——它與 order_items 外鍵取的 FOR KEY SHARE 不衝突，
-- FOR UPDATE 會）→ 刪 → seats_taken = greatest(0, seats_taken - 1)。差別只在
-- release_session_seat() 刪的是**整個 order_item** 的所有列，這裡刪的是**指定的
-- 一列**——同一個 order_item 有 3 位參加者，刪 1 位只能少 1，不能連坐另外 2 位。
--
-- ⚠️ 已付款的報名**也允許刪**（user 已決定）。這支函式不擋、不特別處理——UI 那一層
-- （名單頁）在彈出二次確認之前已經知道這一列的 payment_status（listSessionRoster
-- 回傳的 admin_event_roster view 本來就帶這個欄位），警告文案在那裡顯示，不需要
-- 這支函式多回傳一個「是不是已付款」的欄位。
create or replace function public.admin_delete_registration(
  p_registration_id uuid,
  p_actor_id        uuid
)
returns table (
  deleted boolean,
  reason  text,
  freed   integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session uuid;
begin
  if p_registration_id is null then
    raise exception 'NULL_REGISTRATION_ID';
  end if;

  select r.session_id into v_session
    from public.event_registrations r
   where r.id = p_registration_id;

  if v_session is null then
    return query select false, 'registration_not_found', 0;
    return;
  end if;

  perform 1 from public.event_sessions s where s.id = v_session for no key update;

  delete from public.event_registrations r where r.id = p_registration_id;

  update public.event_sessions s
     set seats_taken = greatest(0, s.seats_taken - 1)
   where s.id = v_session;

  raise log 'admin_delete_registration: % (session %) deleted by %',
    p_registration_id, v_session, p_actor_id;

  return query select true, 'deleted', 1;
end;
$$;

comment on function public.admin_delete_registration(uuid, uuid) is
  '移除單筆報名並還原 1 個名額（0035）。形狀照抄 release_session_seat()，差別是只刪指定的一列，不是整個 order_item。已付款的也允許刪（user 決定）——UI 端用 listSessionRoster() 既有的 payment_status 欄位在確認對話框裡示警，這支函式不另外判斷。reason ∈ deleted | registration_not_found。';

-- ═══════════════════════════════════════════════════════════════════════════
-- §6  權限 —— 三支都只 grant service_role
-- ═══════════════════════════════════════════════════════════════════════════
-- 與 0020 §11 / 0034 §5 相同處理：PostgreSQL 建立函式時預設把 EXECUTE 授給
-- PUBLIC，所以「從 public revoke」才是真正生效的那一半，anon/authenticated 是
-- 保險（public schema 的函式會被 PostgREST 當成 RPC 端點暴露出去）。
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.admin_delete_order(uuid, uuid)',
    'public.admin_archive_order(uuid, uuid, boolean)',
    'public.admin_delete_registration(uuid, uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public', sig);
    execute format('revoke execute on function %s from anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end loop;
end $$;

commit;
