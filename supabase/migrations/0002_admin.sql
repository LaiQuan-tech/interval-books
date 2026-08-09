-- 0002_admin.sql — admin back office support
--
-- Adds what the /admin back office needs on top of 0001:
--   1. public.profiles          — who is allowed in
--   2. handle_new_user trigger  — every auth user gets a profile row
--   3. two reorder RPCs         — reordering under UNIQUE(sort_order) constraints
--
-- Migration convention (see also 0001_init.sql):
--   * Files run in filename order.
--   * An applied file is NEVER edited — add a new numbered file instead.
--   * Applied by pasting into the Supabase Dashboard SQL editor. This repo is
--     the source of truth; there is no CLI/config.toml yet. Revisit once
--     migrations become frequent or more than one person changes the schema.
--
-- Security model: the back office writes exclusively through the service role
-- from TanStack Start server functions. The browser never holds a privileged
-- key, so 0001's "anon/authenticated are read-only" posture is left untouched:
-- no policy is dropped, no grant is widened, no RLS is relaxed.

begin;

-- ---------------------------------------------------------------------------
-- 1. profiles
-- ---------------------------------------------------------------------------
-- One row per auth.users record. `role` is the kill switch: requireAdmin()
-- re-reads this row on every server function call, so flipping a user back to
-- 'customer' revokes access on their next request even though their session
-- cookie is still cryptographically valid.
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  role       text not null default 'customer'
             check (role in ('customer', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Back-office access control. role=admin grants /admin. Read only via the service role — never exposed to anon/authenticated.';
comment on column public.profiles.role is
  'Kill switch: requireAdmin() re-reads this on every admin server function call.';

create index if not exists profiles_role_idx on public.profiles (role);

-- Reuse 0001's shared trigger function rather than defining another one.
drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- RLS with zero policies: enabling RLS denies everything by default, and no
-- policy is ever added. Unlike goodday we never let the browser query profiles
-- (it would need is_admin() SECURITY DEFINER to avoid recursion), so the
-- attack surface here is nil. Only the service role, which bypasses RLS, reads
-- this table.
alter table public.profiles enable row level security;
revoke all on table public.profiles from anon, authenticated;
grant all on table public.profiles to service_role;

-- ---------------------------------------------------------------------------
-- 2. auto-provision a profile for every new auth user
-- ---------------------------------------------------------------------------
-- Accounts are created by hand in the Supabase Dashboard (there is no public
-- sign-up). Without this trigger such an account would have no profile row and
-- requireAdmin() could not evaluate it. New users default to 'customer' —
-- promoting to 'admin' is a deliberate manual UPDATE.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 3. reorder RPCs
-- ---------------------------------------------------------------------------
-- curated_items has UNIQUE(theme_id, sort_order) and page_list_items has
-- UNIQUE(page_slug, list_key, sort_order) (0001_init.sql:321 and :424).
-- Updating rows one at a time to their final positions collides with those
-- constraints mid-flight — swapping two rows raises 23505 no matter the order.
--
-- Rather than drop the constraints (they are genuinely useful: they stop two
-- items claiming the same slot), each function parks the affected rows at
-- negative sort_order values first, then writes the final positions. A plpgsql
-- function body is a single transaction, so the negative values are never
-- visible to anyone else and the constraint holds throughout.
--
-- p_ids arrives in the desired display order; array position becomes sort_order.

create or replace function public.admin_reorder_curated_items(
  p_theme_id text,
  p_ids      bigint[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Park out of the way (negative values can't clash with real ones).
  update curated_items
     set sort_order = -sort_order - 1
   where theme_id = p_theme_id
     and id = any(p_ids);

  -- Write final positions: 1-based index within p_ids.
  update curated_items ci
     set sort_order = pos.ord
    from unnest(p_ids) with ordinality as pos(id, ord)
   where ci.id = pos.id
     and ci.theme_id = p_theme_id;
end;
$$;

create or replace function public.admin_reorder_page_list_items(
  p_page_slug text,
  p_list_key  text,
  p_ids       bigint[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update page_list_items
     set sort_order = -sort_order - 1
   where page_slug = p_page_slug
     and list_key = p_list_key
     and id = any(p_ids);

  update page_list_items pli
     set sort_order = pos.ord
    from unnest(p_ids) with ordinality as pos(id, ord)
   where pli.id = pos.id
     and pli.page_slug = p_page_slug
     and pli.list_key = p_list_key;
end;
$$;

-- SECURITY DEFINER means these run as the owner, so they must not be callable
-- by the public site's keys. Only the service role — i.e. our server functions,
-- which have already passed requireAdmin() — may execute them.
revoke execute on function public.admin_reorder_curated_items(text, bigint[])
  from public, anon, authenticated;
revoke execute on function public.admin_reorder_page_list_items(text, text, bigint[])
  from public, anon, authenticated;

grant execute on function public.admin_reorder_curated_items(text, bigint[])
  to service_role;
grant execute on function public.admin_reorder_page_list_items(text, text, bigint[])
  to service_role;

commit;
