-- 0005_commerce_orders.sql — commerce: orders, payments, invoices, logistics
--
-- Requires 0004 (products).
--
-- ## The one rule that matters most here
--
-- Unlike every other table in this database, these tables are NOT publicly
-- readable. Not "readable when published" — not readable at all.
--
-- The CMS tables grant `select` to anon because their contents are the public
-- website. These tables hold customer names, phone numbers, addresses and
-- purchase history. The browser holds an anon key, so a single
-- `GET /rest/v1/order_addresses` against a publicly-readable table dumps every
-- customer's PII to anyone who looks. That is exactly how realreal leaked
-- (see its 0036_CRITICAL_enable_rls.sql).
--
-- So: RLS on, zero policies, no grants to anon/authenticated. Every read goes
-- through a server function using the service role, and a customer looks up
-- their own order with the unguessable `orders.public_token`.
--
-- ## Money
--
-- TWD whole dollars, integer, everywhere. PayUni, Amego and ECPay all take
-- whole dollars; mixing units is how realreal shipped a coupon that was wrong
-- by a factor of 100.
--
-- ## Status machines
--
-- CHECK constraints enumerate the legal values, but legal *transitions* are
-- enforced in application code. That is a deliberate accepted risk, matching
-- realreal — but it only holds while every write goes through one server-side
-- path. Opening a second write path breaks it.

begin;

-- public_token uses gen_random_bytes(), which lives in pgcrypto. Supabase
-- enables it by default, but stating the dependency means this file also runs
-- on a bare Postgres (which is how it gets verified before being applied).
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Order numbers
-- ---------------------------------------------------------------------------
-- Human-quotable, sortable, and safe as a payment gateway merchant trade no
-- (PayUni: <=25 chars, [A-Za-z0-9_-]).
create sequence if not exists public.order_no_seq;

create or replace function public.next_order_no()
returns text
language sql
volatile
as $$
  select 'IB-' || to_char(now() at time zone 'Asia/Taipei', 'YYYY')
         || lpad(nextval('public.order_no_seq')::text, 8, '0');
$$;

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id             uuid primary key default gen_random_uuid(),
  order_no       text not null unique default public.next_order_no(),

  -- Guests can buy. When set, links to the Supabase auth user.
  user_id        uuid references auth.users (id) on delete set null,

  -- Unguessable lookup key for "view my order" without logging in.
  public_token   text not null unique default encode(gen_random_bytes(24), 'hex'),

  status         text not null default 'pending'
                 check (status in ('pending','processing','shipped','completed','cancelled','failed')),
  payment_status text not null default 'pending'
                 check (payment_status in ('pending','paid','failed','refunded')),

  -- Contact
  customer_name  text not null,
  customer_email text not null,
  customer_phone text not null,

  -- Money — all TWD whole dollars
  subtotal       integer not null check (subtotal >= 0),
  shipping_fee   integer not null default 0 check (shipping_fee >= 0),
  discount       integer not null default 0 check (discount >= 0),
  total          integer not null check (total >= 0),

  shipping_method text not null default 'none'
                  check (shipping_method in ('home','cvs','pickup','none')),
  payment_method  text
                  check (payment_method is null or payment_method in ('card','atm','cvs_cod','test_paid')),

  -- Guards against double-submit; the client sends a UUID per checkout attempt.
  idempotency_key text unique,

  locale         text not null default 'zh' check (locale in ('zh','en','ja')),
  note           text,
  failed_reason  text,

  paid_at        timestamptz,
  shipped_at     timestamptz,
  completed_at   timestamptz,
  cancelled_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.orders is
  'Customer orders. NEVER grant select to anon — contains PII. Customers read their own via public_token through a server function.';
comment on column public.orders.public_token is
  'Unguessable order lookup key for guests. Must never be returned by a status endpoint.';

create index if not exists orders_status_idx on public.orders (status, created_at desc);
create index if not exists orders_payment_status_idx on public.orders (payment_status);
create index if not exists orders_user_idx on public.orders (user_id) where user_id is not null;
create index if not exists orders_email_idx on public.orders (customer_email);

-- ---------------------------------------------------------------------------
-- order_items — snapshot of what was bought
-- ---------------------------------------------------------------------------
-- name/unit_price are copied at purchase time on purpose: editing a product
-- afterwards must never rewrite history on an existing order.
create table if not exists public.order_items (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references public.orders (id) on delete cascade,
  product_id   text references public.products (id) on delete set null,

  name         jsonb not null check (public.is_localized(name)),
  unit_price   integer not null check (unit_price >= 0),
  quantity     integer not null check (quantity > 0),
  subtotal     integer not null check (subtotal >= 0),

  product_type text not null
               check (product_type in ('goods','book','event','journey')),
  created_at   timestamptz not null default now()
);

create index if not exists order_items_order_idx on public.order_items (order_id);

-- ---------------------------------------------------------------------------
-- order_addresses
-- ---------------------------------------------------------------------------
create table if not exists public.order_addresses (
  id            bigint generated always as identity primary key,
  order_id      uuid not null references public.orders (id) on delete cascade,
  type          text not null default 'shipping' check (type in ('shipping','billing')),

  recipient     text not null,
  phone         text not null,

  -- Home delivery
  postal_code   text,
  city          text,
  district      text,
  street        text,

  -- Convenience store pickup (ECPay)
  cvs_store_id   text,
  cvs_store_name text,
  cvs_address    text,
  cvs_sub_type   text check (cvs_sub_type is null or cvs_sub_type in ('UNIMARTC2C','FAMIC2C')),

  created_at    timestamptz not null default now(),
  unique (order_id, type)
);

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders (id) on delete cascade,
  gateway       text not null default 'payuni',
  gateway_tx_id text,
  status        text not null default 'pending'
                check (status in ('pending','paid','failed','refunded')),
  amount        integer not null check (amount >= 0),
  raw_response  jsonb,
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One live gateway transaction per order per gateway.
create unique index if not exists payments_gateway_tx_idx
  on public.payments (gateway, gateway_tx_id)
  where gateway_tx_id is not null;
create index if not exists payments_order_idx on public.payments (order_id);

-- ---------------------------------------------------------------------------
-- invoices (Amego 光貿)
-- ---------------------------------------------------------------------------
-- `issuing` exists so a worker can claim a row atomically before calling Amego:
--
--   update invoices set status='issuing' where id=$1 and status='pending' returning *
--
-- Without that claim, two concurrent runs both see 'pending' and both issue —
-- and an issued invoice is a real government tax document that cannot be
-- un-issued, only voided. Never call Amego without holding the claim.
create table if not exists public.invoices (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders (id) on delete cascade,

  status         text not null default 'pending'
                 check (status in ('pending','issuing','issued','voided','failed')),

  invoice_number text,
  random_code    text,
  issued_at      timestamptz,

  -- Buyer-supplied invoice details, captured at checkout.
  invoice_type   text not null default 'personal'
                 check (invoice_type in ('personal','company','donate')),
  carrier_type   text,          -- 3J0002 mobile barcode / CQ0001 natural person cert
  carrier_number text,
  love_code      text,          -- donation code
  tax_id         text,          -- 統一編號
  company_title  text,

  -- Retry bookkeeping for the async issuer.
  retry_count    integer not null default 0 check (retry_count >= 0),
  error_message  text,
  locked_at      timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- At most one invoice per order.
create unique index if not exists invoices_order_idx on public.invoices (order_id);
create index if not exists invoices_pending_idx on public.invoices (status, retry_count)
  where status in ('pending','failed');

comment on column public.invoices.status is
  'pending -> issuing (claimed) -> issued. Claim atomically before calling Amego; a real invoice cannot be un-issued.';

-- ---------------------------------------------------------------------------
-- logistics (ECPay)
-- ---------------------------------------------------------------------------
create table if not exists public.logistics (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders (id) on delete cascade,

  provider           text not null default 'ecpay',
  type               text not null check (type in ('cvs','home')),
  ecpay_logistics_id text,

  status             text not null default 'pending',
  cvs_payment_no     text,
  cvs_validation_no  text,
  tracking_no        text,

  retry_count        integer not null default 0 check (retry_count >= 0),
  error_message      text,
  locked_at          timestamptz,
  raw_response       jsonb,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists logistics_order_idx on public.logistics (order_id);
create index if not exists logistics_pending_idx on public.logistics (status, retry_count)
  where status in ('pending','failed');

-- ---------------------------------------------------------------------------
-- webhook_events — deduplication for every gateway
-- ---------------------------------------------------------------------------
-- Generic on purpose. goodday only guarded "pending -> paid" with a CAS, which
-- works until a second kind of webhook shows up (invoice, logistics, refund)
-- and then protects nothing. A unique key per (gateway, event_key) covers all
-- of them with one mechanism.
create table if not exists public.webhook_events (
  id         bigint generated always as identity primary key,
  gateway    text not null,
  event_key  text not null,
  payload    jsonb,
  created_at timestamptz not null default now(),
  unique (gateway, event_key)
);

-- ---------------------------------------------------------------------------
-- order_post_payment_log — claim-then-act audit
-- ---------------------------------------------------------------------------
-- One row per (order, step). Inserting the row IS the claim: the unique
-- constraint makes a second concurrent caller fail instead of running the step
-- twice. This is what stops "invoice issued twice" / "notification sent twice"
-- when a webhook is redelivered while the first is still running.
--
-- Mark completed_at only AFTER the step succeeds — claiming and completing in
-- one write would let a crash mid-step look like success.
create table if not exists public.order_post_payment_log (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references public.orders (id) on delete cascade,
  step         text not null check (step in ('invoice','logistics','notify')),
  claimed_at   timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  unique (order_id, step)
);

comment on table public.order_post_payment_log is
  'Claim-then-act guard for post-payment steps. The unique(order_id, step) IS the lock; set completed_at only after success.';

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['orders','payments','invoices','logistics']
  loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS — deny everything to the browser
-- ---------------------------------------------------------------------------
-- No policies are created. RLS with zero policies denies all access, and the
-- grants are revoked as well, so neither the policy layer nor the privilege
-- layer alone is load-bearing. service_role bypasses RLS and is the only way in.
do $$
declare t text;
begin
  foreach t in array array[
    'orders','order_items','order_addresses','payments',
    'invoices','logistics','webhook_events','order_post_payment_log'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

grant usage, select on sequence public.order_no_seq to service_role;
revoke execute on function public.next_order_no() from public, anon, authenticated;
grant execute on function public.next_order_no() to service_role;

commit;
