-- 0004_commerce_products.sql — commerce: product catalogue
--
-- Adds the product side of the shop. Orders, payments, invoices and logistics
-- come in 0005; this file must be applied first (0005 references products).
--
-- Design decisions worth knowing before changing anything here:
--
-- 1. Products are a NEW table, not a rewrite of events/journeys/curated_items.
--    Those three already drive the public site and the admin back office, and
--    "what the page says" is a different concern from "what you can buy".
--    A product points back at its source row via (source_type, source_id) so
--    the shop can reuse existing copy without the CMS having to know about
--    money.
--
-- 2. Money is TWD integers — not cents, not numeric. Every downstream system
--    (PayUni, Amego, ECPay) takes whole NT dollars, and mixing units is how
--    realreal shipped a coupon that was wrong by a factor of 100.
--
-- 3. Localized fields stay jsonb {zh,en,ja} with the is_localized() CHECK, the
--    same as every other table here. goodday had to add i18n to products after
--    the fact and it cost a whole migration; starting three-language is free.
--
-- 4. Stock deduction goes through atomic_deduct_stock() below. Read the comment
--    on that function before writing any other stock path.

begin;

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id            text primary key,
  slug          text not null unique,

  -- goods/book ship physically; event/journey are bookings with capacity.
  -- The distinction drives checkout: shipping fields and stock only apply to
  -- the first two, capacity only to the last two.
  product_type  text not null
                check (product_type in ('goods', 'book', 'event', 'journey')),

  -- Optional link back to the CMS row this product is sold from.
  -- Deliberately not a FK: the three source tables have different id types and
  -- a product should survive its source being unpublished.
  source_type   text check (source_type in ('event', 'journey', 'curated_item')),
  source_id     text,

  title         jsonb not null check (public.is_localized(title)),
  summary       jsonb not null check (public.is_localized(summary)),
  description   jsonb not null check (public.is_localized(description)),

  -- TWD, whole dollars. compare_at_price is the struck-through "was" price.
  price            integer not null check (price >= 0),
  compare_at_price integer check (compare_at_price is null or compare_at_price >= 0),

  -- Physical goods only. NULL means "not stock-managed" (events use capacity).
  stock         integer check (stock is null or stock >= 0),

  -- Bookings only. seats_taken is maintained by reserve_product_seat().
  capacity      integer check (capacity is null or capacity >= 0),
  seats_taken   integer not null default 0 check (seats_taken >= 0),

  image_key     text,
  requires_shipping boolean not null default true,

  status        text not null default 'draft'
                check (status in ('draft', 'active', 'archived')),
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A bookable product needs capacity; a shippable one needs stock.
  constraint products_capacity_shape check (
    (product_type in ('event', 'journey') and capacity is not null)
    or (product_type in ('goods', 'book'))
  ),
  constraint products_seats_within_capacity check (
    capacity is null or seats_taken <= capacity
  )
);

comment on table public.products is
  'Sellable items. Points back at events/journeys/curated_items via (source_type, source_id) rather than replacing them.';
comment on column public.products.price is 'TWD, whole dollars — never cents.';
comment on column public.products.stock is
  'NULL = not stock-managed. Only ever change via atomic_deduct_stock().';

create index if not exists products_status_idx on public.products (status, sort_order);
create index if not exists products_type_idx on public.products (product_type);
create index if not exists products_source_idx on public.products (source_type, source_id);

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — public may read only what is on sale
-- ---------------------------------------------------------------------------
-- Same posture as the CMS tables: anon/authenticated can SELECT active rows and
-- can never write. Writes are service_role only, from the server.
alter table public.products enable row level security;
revoke all on table public.products from anon, authenticated;
grant select on table public.products to anon, authenticated;
grant all on table public.products to service_role;

drop policy if exists products_select_public on public.products;
create policy products_select_public on public.products
  as permissive for select to anon, authenticated
  using (status = 'active');

drop policy if exists products_deny_insert on public.products;
create policy products_deny_insert on public.products
  as restrictive for insert to anon, authenticated with check (false);
drop policy if exists products_deny_update on public.products;
create policy products_deny_update on public.products
  as restrictive for update to anon, authenticated using (false) with check (false);
drop policy if exists products_deny_delete on public.products;
create policy products_deny_delete on public.products
  as restrictive for delete to anon, authenticated using (false);

-- ---------------------------------------------------------------------------
-- atomic_deduct_stock — the only correct way to reduce stock
-- ---------------------------------------------------------------------------
-- Read-modify-write on stock is how you oversell. The failure is silent: two
-- concurrent orders both read stock=5, both pass a `stock >= qty` guard, both
-- write stock=2, and six units ship against two units of inventory with nothing
-- in the data to show for it.
--
-- This function instead:
--   1. locks the affected rows FOR UPDATE **in id order** — a consistent
--      ordering is what stops two multi-item orders deadlocking on each other,
--   2. deducts *relatively* (stock = stock - qty), never writing back a value
--      that was read earlier,
--   3. raises on the first line that cannot be satisfied, so the whole
--      transaction rolls back — partial deduction is never observable.
--
-- Callers MUST let the exception propagate. Swallowing it reintroduces the
-- exact bug this exists to prevent.
--
-- p_items: [{"product_id": "...", "quantity": 2}, ...]
create or replace function public.atomic_deduct_stock(p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item   record;
  v_stock  integer;
begin
  -- Lock in a deterministic order first, before touching anything.
  perform 1
    from public.products
   where id in (select jsonb_array_elements(p_items) ->> 'product_id')
   order by id
     for update;

  for v_item in
    select (e ->> 'product_id') as product_id,
           (e ->> 'quantity')::integer as quantity
      from jsonb_array_elements(p_items) as e
     order by 1
  loop
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'INVALID_QUANTITY:%', v_item.product_id;
    end if;

    update public.products
       set stock = stock - v_item.quantity
     where id = v_item.product_id
       and stock is not null
       and stock >= v_item.quantity
    returning stock into v_stock;

    if not found then
      -- Either the product does not exist, is not stock-managed, or there is
      -- not enough left. All three are "cannot fulfil" from the caller's view.
      raise exception 'INSUFFICIENT_STOCK:%', v_item.product_id
        using errcode = 'check_violation';
    end if;
  end loop;
end;
$$;

comment on function public.atomic_deduct_stock(jsonb) is
  'Only correct way to reduce product stock. Locks in id order, deducts relatively, raises INSUFFICIENT_STOCK on any shortfall so the whole transaction rolls back.';

-- ---------------------------------------------------------------------------
-- reserve_product_seat — capacity equivalent for events/journeys
-- ---------------------------------------------------------------------------
-- Same reasoning as above, for bookings. Kept separate because the failure
-- mode differs: stock can be replenished, a seat cannot be double-sold.
create or replace function public.reserve_product_seat(
  p_product_id text,
  p_quantity   integer default 1
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity integer;
  v_taken    integer;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY:%', p_product_id;
  end if;

  select capacity, seats_taken into v_capacity, v_taken
    from public.products
   where id = p_product_id
     for update;   -- serialises concurrent bookings on this row

  if not found then
    raise exception 'PRODUCT_NOT_FOUND:%', p_product_id;
  end if;
  if v_capacity is null then
    raise exception 'NOT_BOOKABLE:%', p_product_id;
  end if;
  if v_taken + p_quantity > v_capacity then
    raise exception 'NO_SEATS_LEFT:%', p_product_id
      using errcode = 'check_violation';
  end if;

  update public.products
     set seats_taken = seats_taken + p_quantity
   where id = p_product_id;
end;
$$;

comment on function public.reserve_product_seat(text, integer) is
  'Capacity counterpart to atomic_deduct_stock, for event/journey products. FOR UPDATE serialises concurrent bookings.';

-- Both are SECURITY DEFINER, so they must not be reachable by the public keys.
revoke execute on function public.atomic_deduct_stock(jsonb) from public, anon, authenticated;
revoke execute on function public.reserve_product_seat(text, integer) from public, anon, authenticated;
grant execute on function public.atomic_deduct_stock(jsonb) to service_role;
grant execute on function public.reserve_product_seat(text, integer) to service_role;

commit;
