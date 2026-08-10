-- 0006_order_expiry.sql — give the stock back when nobody pays
--
-- Requires 0004 (products) and 0005 (orders).
--
-- ## Why this file has to exist at the same time as the payment gateway
--
-- src/server/repos/orders.ts deducts stock and reserves seats at *order* time,
-- before a single dollar has moved. That was harmless while there was nowhere
-- to pay: an order was created by someone sitting at the checkout form, and it
-- was created because they meant it.
--
-- Adding PayUni changes the shape of the failure. The shopper is now sent away
-- to a page we do not control, and the ways that ends badly are ordinary rather
-- than exotic: they close the tab, their card is declined, their phone dies,
-- the gateway never sends the notification. Every one of those leaves a
-- `pending` order holding stock and event seats that nobody can buy — silently,
-- permanently, and worst on exactly the products that sell out.
--
-- realreal is the cautionary tale here. It has a payment gateway and no
-- reclaim path at all, so its unpaid orders hold inventory forever and the only
-- cure is someone noticing and fixing it by hand. Do not copy that.
--
-- ## What "in one transaction" buys, and why it is not optional
--
-- Cancelling the order and restoring the stock are the same fact stated twice.
-- Split across two statements, a failure between them produces either stock
-- that was given back on an order still holding it (oversell) or an order
-- cancelled with its stock still deducted (phantom shortage). A plpgsql
-- function body is one transaction, so both land or neither does.
--
-- ## The race that matters: a payment landing mid-sweep
--
-- The claim below takes `for update skip locked`, and those row locks are held
-- until this function's transaction commits. So:
--
--   * A webhook that marked the order paid BEFORE the claim never enters the
--     candidate set — READ COMMITTED re-evaluates the predicate after the lock
--     is granted, and `payment_status <> 'paid'` is part of it.
--   * A webhook that arrives DURING the sweep blocks on the row lock, then
--     finds the order cancelled. Its own guard (`status='pending' and
--     payment_status='pending'`, in src/server/repos/payments.ts) fails, and it
--     reports paid_after_cancel loudly instead of quietly flipping a cancelled
--     order to paid. Money in, stock already back on the shelf, and a human
--     told about it — which is the correct outcome, not a bug to paper over.
--
-- `skip locked` also means two schedulers running at once divide the work
-- rather than deadlock or double-restore.
--
-- ## ⚠️ NOTHING CALLS THIS YET
--
-- There is no scheduler in this project. This function is inert until
-- something invokes it — the plan is a Railway worker on a few-minute cron
-- (next phase), and pg_cron is the alternative if the worker slips:
--
--   select cron.schedule('expire-unpaid-orders', '*/5 * * * *',
--                        $$select public.expire_unpaid_orders()$$);
--
-- Until one of those exists, unpaid orders still hold stock. Shipping the
-- gateway without wiring a caller to this function leaves the hole this file
-- was written to close.

begin;

-- ---------------------------------------------------------------------------
-- expire_unpaid_orders
-- ---------------------------------------------------------------------------
-- p_older_than: how long an order may sit unpaid before it is reclaimed.
--   The default of 30 minutes is deliberately generous — PayUni's page allows
--   a card to be re-entered, and a shopper fetching their card from another
--   room must not lose the order. It must never be shorter than the gateway's
--   own session timeout, or a payment can succeed upstream after we have
--   already given the stock away.
-- p_limit: bound on one sweep, so a backlog is worked through in batches
--   instead of one transaction holding thousands of row locks.
--
-- Returns one row per order actually cancelled, with what went back, so the
-- caller can log something meaningful rather than "done".
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
  -- THREE separate guards against reclaiming a paid order, on purpose. They
  -- are cheap and they fail independently: `status` catches an order that has
  -- moved on, `payment_status` catches the money, and `paid_at` catches a row
  -- whose status columns were edited by hand without the timestamp. A paid
  -- order must never lose its stock, so this is the one place worth the
  -- redundancy.
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
  -- Same discipline as atomic_deduct_stock() in 0004: a consistent lock order
  -- is what stops this sweep and a concurrent checkout deadlocking on each
  -- other when they touch the same two products in opposite orders.
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
  -- Relative (`stock + qty`), never a value read earlier — writing back a
  -- number computed outside the statement is the read-modify-write bug that
  -- atomic_deduct_stock() exists to prevent, and it is just as wrong going up
  -- as going down.
  --
  -- `stock is not null` skips products that are not stock-managed. They were
  -- never deducted (createOrder filters them out of atomic_deduct_stock), so
  -- crediting them would invent inventory out of nothing.
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
  -- An order may hold both physical goods and event places; both have to be
  -- returned, which is why this is a second statement rather than an else.
  --
  -- greatest(0, …) keeps the products_seats_taken_check (>= 0) satisfiable
  -- even if seats were adjusted by hand in the admin in the meantime. Clamping
  -- loses a seat; underflowing aborts the whole sweep.
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

  -- ---- 5. cancel the orders ---------------------------------------------
  -- The guard is restated even though the rows are locked: it costs nothing
  -- and it means a future edit to the claim query cannot quietly turn this
  -- into "cancel whatever is in the array".
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
  -- Counted with the same joins the restore used (product still exists; stock
  -- actually managed), so the numbers reported are the numbers returned rather
  -- than the numbers ordered.
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
  'Cancels pending orders left unpaid past p_older_than and returns their stock and seats, all in one transaction. Never touches a paid order (three independent guards). NOT SCHEDULED YET — a Railway worker or pg_cron must call it.';

-- SECURITY DEFINER, so it must not be reachable by the browser keys. Same
-- treatment as atomic_deduct_stock / reserve_product_seat in 0004: execute is
-- granted to public by default, so revoking from public is the load-bearing
-- half and revoking from anon/authenticated is the belt to its braces.
revoke execute on function public.expire_unpaid_orders(interval, integer) from public;
revoke execute on function public.expire_unpaid_orders(interval, integer) from anon, authenticated;
grant  execute on function public.expire_unpaid_orders(interval, integer) to service_role;

commit;
