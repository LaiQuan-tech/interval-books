-- =============================================================================
-- Interval Books / 小時光書店 — content layer, initial schema
-- Project: interval-books (ap-northeast-1)
-- Source of truth being migrated:
--   src/data/content.ts   — events / exhibitions / journeys / news /
--                           curatedThemes / collaborations
--   src/i18n/strings.ts   — UI strings, SITE_INFO, CONTACT_*, SOCIAL, MAP
--   src/routes/*.tsx      — per-page copy (meta, page header, section copy)
--
-- i18n model
--   The app has no per-language content files. Every translatable field is a
--   `Localized = { zh, en, ja }` object stored INLINE next to the field
--   (src/i18n/types.ts:3) and resolved at render time by
--   `t(entry) => entry[lang] || entry.zh` (src/i18n/LanguageContext.tsx:52).
--   The schema mirrors that exactly: every translatable column is `jsonb`
--   holding {"zh":…,"en":…,"ja":…}, so the frontend can keep calling
--   `t(row.title)` with zero reshaping.
--
-- Naming
--   Columns are snake_case (Postgres/PostgREST convention). The TS side uses
--   camelCase; the mapping is 1:1 and mechanical (externalUrl -> external_url).
--   Two renames were forced: `desc` -> `description` (DESC is a SQL keyword)
--   and `date` -> `display_date` (it is a free-form display string, not a date).
--
-- Security model
--   Every table: RLS enabled, anon+authenticated get SELECT only (table grant
--   AND a FOR SELECT policy), plus explicit RESTRICTIVE deny policies for
--   INSERT / UPDATE / DELETE. All writes go through service_role, which
--   bypasses RLS. No table is left open for writes.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Helper functions
-- -----------------------------------------------------------------------------

-- Keeps updated_at honest on every UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger function: stamps updated_at = now() on UPDATE.';

-- Shape guard for every translatable column: must be a JSON object carrying
-- all three languages the app knows about (src/i18n/types.ts LANGS).
create or replace function public.is_localized(v jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select v is not null
     and jsonb_typeof(v) = 'object'
     and (v -> 'zh') is not null
     and (v -> 'en') is not null
     and (v -> 'ja') is not null;
$$;

comment on function public.is_localized(jsonb) is
  'True when the jsonb value is an object with zh / en / ja keys (Localized).';


-- -----------------------------------------------------------------------------
-- 1. site_settings — singleton: SITE_INFO, CONTACT_*, SOCIAL, MAP, root <head>
--    src/i18n/strings.ts:59-107, src/routes/__root.tsx:43-52
-- -----------------------------------------------------------------------------
create table public.site_settings (
  id                       smallint primary key generated always as identity,
  short_desc               jsonb not null,
  address                  jsonb not null,
  city                     jsonb not null,
  hours                    jsonb not null,
  closed                   jsonb not null,
  contact_email            text  not null,
  site_url                 text  not null,
  social_instagram         text  not null default '',
  social_facebook          text  not null default '',
  social_line              text  not null default '',
  map_embed                text  not null,
  map_link                 text  not null,
  map_apple                text  not null,
  meta_site_name           text  not null,
  meta_author              text  not null,
  meta_twitter_card        text  not null default 'summary_large_image',
  meta_og_type             text  not null default 'website',
  default_meta_title       text  not null,
  default_meta_description text  not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint site_settings_singleton check (id = 1),
  constraint site_settings_short_desc_localized check (public.is_localized(short_desc)),
  constraint site_settings_address_localized    check (public.is_localized(address)),
  constraint site_settings_city_localized       check (public.is_localized(city)),
  constraint site_settings_hours_localized      check (public.is_localized(hours)),
  constraint site_settings_closed_localized     check (public.is_localized(closed))
);

comment on table  public.site_settings is 'Single-row site configuration (SITE_INFO / SOCIAL / MAP / root head meta).';
comment on column public.site_settings.closed is 'SITE_INFO.closed — defined in strings.ts but not rendered by any route today.';
comment on column public.site_settings.social_facebook is 'Empty string hides the link in SiteFooter (src/components/SiteFooter.tsx:52).';


-- -----------------------------------------------------------------------------
-- 2. ui_strings — the UI object from src/i18n/strings.ts:4-57 plus the 404 copy
--    group_key/string_key mirror the TS path, e.g. UI.buttons.toEvent
--    -> ('buttons','toEvent')
-- -----------------------------------------------------------------------------
create table public.ui_strings (
  group_key  text not null,
  string_key text not null,
  value      jsonb not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_key, string_key),
  constraint ui_strings_value_localized check (public.is_localized(value))
);

comment on table public.ui_strings is
  'Flat lookup for chrome copy (nav, footer, buttons, section headings, 404). Rebuilt client-side into the UI object shape.';

create index ui_strings_group_idx on public.ui_strings (group_key, sort_order);


-- -----------------------------------------------------------------------------
-- 3. contact_phones — src/i18n/strings.ts:90-93
-- -----------------------------------------------------------------------------
create table public.contact_phones (
  id           bigint primary key generated always as identity,
  label        text not null,
  display_text text not null,
  tel          text not null,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table  public.contact_phones is 'CONTACT_PHONES — label / human-readable number / tel: href value.';
comment on column public.contact_phones.display_text is 'CONTACT_PHONES[].display (renamed: `display` reads ambiguously in SQL).';


-- -----------------------------------------------------------------------------
-- 4. event_categories — the EventCategory union (src/data/content.ts:4-10)
--    plus the localized labels from src/routes/events.tsx:24-31.
--    id keeps the Chinese literal because that is what events.category holds
--    and what the filter buttons compare against.
-- -----------------------------------------------------------------------------
create table public.event_categories (
  id         text primary key,
  label      jsonb not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_categories_label_localized check (public.is_localized(label))
);

comment on table public.event_categories is
  'Replaces the EventCategory TS union + CATEGORY_LABEL map. sort_order follows FILTERS in events.tsx:48-56.';


-- -----------------------------------------------------------------------------
-- 5. events — src/data/content.ts:70-209
-- -----------------------------------------------------------------------------
create table public.events (
  id                text primary key,
  title             jsonb not null,
  summary           jsonb not null,
  description       jsonb not null,
  display_date      text  not null,
  iso_date          date,
  category          text  not null references public.event_categories (id)
                      on update cascade on delete restrict,
  external_url      text  not null,
  registration_type text  not null default 'external',
  payment_enabled   boolean not null default false,
  sort_order        integer not null default 0,
  is_published      boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint events_title_localized       check (public.is_localized(title)),
  constraint events_summary_localized     check (public.is_localized(summary)),
  constraint events_description_localized check (public.is_localized(description)),
  constraint events_registration_type_valid check (registration_type in ('external', 'internal'))
);

comment on column public.events.display_date      is 'EventItem.date — free-form display string ("即將公告", "2025.05.24  Sat  19:30").';
comment on column public.events.iso_date          is 'EventItem.isoDate — declared for phase 2 sorting, never populated in content.ts.';
comment on column public.events.description       is 'EventItem.description — present in the data but not rendered by any route yet.';
comment on column public.events.registration_type is 'Phase-2 field: set to "external" everywhere, not read by any route yet.';
comment on column public.events.payment_enabled   is 'Phase-2 field: false everywhere, not read by any route yet.';

create index events_sort_idx     on public.events (sort_order, id);
create index events_category_idx on public.events (category);
create index events_published_idx on public.events (is_published) where is_published;


-- -----------------------------------------------------------------------------
-- 6. exhibitions — src/data/content.ts:211-262
-- -----------------------------------------------------------------------------
create table public.exhibitions (
  id           text primary key,
  slug         text not null unique,
  title        jsonb not null,
  summary      jsonb not null,
  description  jsonb not null,
  period       text  not null,
  location     jsonb not null,
  image_key    text,
  sort_order   integer not null default 0,
  is_published boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint exhibitions_title_localized       check (public.is_localized(title)),
  constraint exhibitions_summary_localized     check (public.is_localized(summary)),
  constraint exhibitions_description_localized check (public.is_localized(description)),
  constraint exhibitions_location_localized    check (public.is_localized(location))
);

comment on column public.exhibitions.slug      is 'Used as the in-page anchor from the home page (index.tsx:179).';
comment on column public.exhibitions.image_key is
  'Asset filename only. Images are Vite-imported, content-hashed bundle assets, so the DB stores a key the frontend maps to an import — not a URL.';

create index exhibitions_sort_idx on public.exhibitions (sort_order, id);


-- -----------------------------------------------------------------------------
-- 7. journeys — src/data/content.ts:264-346
-- -----------------------------------------------------------------------------
create table public.journeys (
  id                text primary key,
  title             jsonb not null,
  summary           jsonb not null,
  description       jsonb not null,
  days              jsonb not null,
  theme             jsonb not null,
  external_url      text  not null,
  registration_type text  not null default 'external',
  payment_enabled   boolean not null default false,
  sort_order        integer not null default 0,
  is_published      boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint journeys_title_localized       check (public.is_localized(title)),
  constraint journeys_summary_localized     check (public.is_localized(summary)),
  constraint journeys_description_localized check (public.is_localized(description)),
  constraint journeys_days_localized        check (public.is_localized(days)),
  constraint journeys_theme_localized       check (public.is_localized(theme)),
  constraint journeys_registration_type_valid check (registration_type in ('external', 'internal'))
);

comment on column public.journeys.description is 'JourneyItem.description — present in the data but not rendered by any route yet.';

create index journeys_sort_idx on public.journeys (sort_order, id);


-- -----------------------------------------------------------------------------
-- 8. news — src/data/content.ts:348-406
-- -----------------------------------------------------------------------------
create table public.news (
  id           text primary key,
  title        jsonb not null,
  summary      jsonb not null,
  description  jsonb not null,
  display_date text  not null,
  sort_order   integer not null default 0,
  is_published boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint news_title_localized       check (public.is_localized(title)),
  constraint news_summary_localized     check (public.is_localized(summary)),
  constraint news_description_localized check (public.is_localized(description))
);

comment on column public.news.display_date is 'NewsItem.date — free-form display string ("2026.05.22–05.24"), not parseable as a date.';

create index news_sort_idx on public.news (sort_order, id);


-- -----------------------------------------------------------------------------
-- 9/10. curated_themes + curated_items — src/data/content.ts:408-514
--       Split into two tables because CuratedTheme.items is a real repeated
--       record (name + note), which the admin needs to edit row by row.
-- -----------------------------------------------------------------------------
create table public.curated_themes (
  id           text primary key,
  title        jsonb not null,
  description  jsonb not null,
  sort_order   integer not null default 0,
  is_published boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint curated_themes_title_localized       check (public.is_localized(title)),
  constraint curated_themes_description_localized check (public.is_localized(description))
);

create index curated_themes_sort_idx on public.curated_themes (sort_order, id);

create table public.curated_items (
  id           bigint primary key generated always as identity,
  theme_id     text not null references public.curated_themes (id)
                 on update cascade on delete cascade,
  name         jsonb not null,
  note         jsonb not null,
  sort_order   integer not null default 0,
  is_published boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint curated_items_name_localized check (public.is_localized(name)),
  constraint curated_items_note_localized check (public.is_localized(note)),
  constraint curated_items_theme_order_uniq unique (theme_id, sort_order)
);

create index curated_items_theme_idx on public.curated_items (theme_id, sort_order);


-- -----------------------------------------------------------------------------
-- 11. collaborations — src/data/content.ts:517-566
--     Source objects have no id; stable ids co-1..co-4 assigned here.
-- -----------------------------------------------------------------------------
create table public.collaborations (
  id           text primary key,
  title        jsonb not null,
  description  jsonb not null,
  sort_order   integer not null default 0,
  is_published boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint collaborations_title_localized       check (public.is_localized(title)),
  constraint collaborations_description_localized check (public.is_localized(description))
);

comment on column public.collaborations.description is 'Source key is `desc`; renamed because DESC is a SQL keyword.';

create index collaborations_sort_idx on public.collaborations (sort_order, id);


-- -----------------------------------------------------------------------------
-- 12. pages — per-route document meta (useDocumentMeta) + PageHeader copy
--     src/i18n/useDocumentMeta.ts:5-11, src/components/PageShell.tsx:15-38
-- -----------------------------------------------------------------------------
create table public.pages (
  slug             text primary key,
  meta_title       jsonb not null,
  meta_description jsonb not null,
  og_title         jsonb,
  og_description   jsonb,
  og_image_key     text,
  eyebrow_prefix   text,
  eyebrow_suffix   jsonb,
  header_title     jsonb,
  header_intro     jsonb,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint pages_meta_title_localized       check (public.is_localized(meta_title)),
  constraint pages_meta_description_localized check (public.is_localized(meta_description)),
  constraint pages_og_title_localized         check (og_title       is null or public.is_localized(og_title)),
  constraint pages_og_description_localized   check (og_description is null or public.is_localized(og_description)),
  constraint pages_eyebrow_suffix_localized   check (eyebrow_suffix is null or public.is_localized(eyebrow_suffix)),
  constraint pages_header_title_localized     check (header_title   is null or public.is_localized(header_title)),
  constraint pages_header_intro_localized     check (header_intro   is null or public.is_localized(header_intro))
);

comment on table  public.pages is 'One row per route file in src/routes (excluding __root).';
comment on column public.pages.og_description is
  'MetaInput supports it but no route passes ogDescription today — NULL everywhere on purpose.';
comment on column public.pages.eyebrow_prefix is
  'Latin half of the PageHeader eyebrow ("Visit"), joined with eyebrow_suffix by the frontend.';
comment on column public.pages.og_image_key is 'Asset filename; see exhibitions.image_key for why this is not a URL.';


-- -----------------------------------------------------------------------------
-- 13. page_blocks — the remaining route-local copy, keyed by its TS path
--     e.g. index.tsx HERO.titleSub -> ('index', 'hero.titleSub')
-- -----------------------------------------------------------------------------
create table public.page_blocks (
  id         bigint primary key generated always as identity,
  page_slug  text not null references public.pages (slug)
               on update cascade on delete cascade,
  block_key  text not null,
  value      jsonb not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint page_blocks_value_localized check (public.is_localized(value)),
  constraint page_blocks_key_uniq unique (page_slug, block_key)
);

comment on table public.page_blocks is
  'Standalone localized strings that live inside a route file today (HERO.*, ENTRIES.*, PAGE.* leftovers, privacy body).';

create index page_blocks_page_idx on public.page_blocks (page_slug, sort_order);


-- -----------------------------------------------------------------------------
-- 14. page_list_items — the repeated lists inside route files
--     visit.tsx METRO/BUS/DRIVE/WALK/INSIDE, about.tsx WORK/SPACE,
--     index.tsx three entry cards
-- -----------------------------------------------------------------------------
create table public.page_list_items (
  id         bigint primary key generated always as identity,
  page_slug  text not null references public.pages (slug)
               on update cascade on delete cascade,
  list_key   text not null,
  label      jsonb not null,
  note       jsonb,
  image_key  text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint page_list_items_label_localized check (public.is_localized(label)),
  constraint page_list_items_note_localized  check (note is null or public.is_localized(note)),
  constraint page_list_items_order_uniq unique (page_slug, list_key, sort_order)
);

comment on column public.page_list_items.note is
  'Second line where the list carries pairs (about WORK title+desc, index entry cards label+desc); NULL for plain string lists.';

create index page_list_items_page_idx on public.page_list_items (page_slug, list_key, sort_order);


-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
create trigger site_settings_set_updated_at before update on public.site_settings
  for each row execute function public.set_updated_at();
create trigger ui_strings_set_updated_at before update on public.ui_strings
  for each row execute function public.set_updated_at();
create trigger contact_phones_set_updated_at before update on public.contact_phones
  for each row execute function public.set_updated_at();
create trigger event_categories_set_updated_at before update on public.event_categories
  for each row execute function public.set_updated_at();
create trigger events_set_updated_at before update on public.events
  for each row execute function public.set_updated_at();
create trigger exhibitions_set_updated_at before update on public.exhibitions
  for each row execute function public.set_updated_at();
create trigger journeys_set_updated_at before update on public.journeys
  for each row execute function public.set_updated_at();
create trigger news_set_updated_at before update on public.news
  for each row execute function public.set_updated_at();
create trigger curated_themes_set_updated_at before update on public.curated_themes
  for each row execute function public.set_updated_at();
create trigger curated_items_set_updated_at before update on public.curated_items
  for each row execute function public.set_updated_at();
create trigger collaborations_set_updated_at before update on public.collaborations
  for each row execute function public.set_updated_at();
create trigger pages_set_updated_at before update on public.pages
  for each row execute function public.set_updated_at();
create trigger page_blocks_set_updated_at before update on public.page_blocks
  for each row execute function public.set_updated_at();
create trigger page_list_items_set_updated_at before update on public.page_list_items
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- Row Level Security
--
--   Read : anon + authenticated, SELECT only.
--          Tables carrying is_published expose published rows only, so drafts
--          created in the admin never leak to the public site.
--   Write: no permissive policy exists for INSERT / UPDATE / DELETE, and an
--          explicit RESTRICTIVE deny policy is added on top of that for each of
--          the three commands. Table privileges are revoked as well, so the
--          block holds even if a permissive policy is ever added by mistake.
--          service_role bypasses RLS and is the only writer (future admin).
-- -----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

-- site_settings
alter table public.site_settings enable row level security;
revoke all on table public.site_settings from anon, authenticated;
grant select on table public.site_settings to anon, authenticated;
grant all    on table public.site_settings to service_role;

create policy "site_settings_select_public" on public.site_settings
  as permissive for select to anon, authenticated
  using (true);                     -- public reference data

create policy "site_settings_deny_insert" on public.site_settings
  as restrictive for insert to anon, authenticated with check (false);

create policy "site_settings_deny_update" on public.site_settings
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "site_settings_deny_delete" on public.site_settings
  as restrictive for delete to anon, authenticated using (false);

-- ui_strings
alter table public.ui_strings enable row level security;
revoke all on table public.ui_strings from anon, authenticated;
grant select on table public.ui_strings to anon, authenticated;
grant all    on table public.ui_strings to service_role;

create policy "ui_strings_select_public" on public.ui_strings
  as permissive for select to anon, authenticated
  using (true);                     -- public reference data

create policy "ui_strings_deny_insert" on public.ui_strings
  as restrictive for insert to anon, authenticated with check (false);

create policy "ui_strings_deny_update" on public.ui_strings
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "ui_strings_deny_delete" on public.ui_strings
  as restrictive for delete to anon, authenticated using (false);

-- contact_phones
alter table public.contact_phones enable row level security;
revoke all on table public.contact_phones from anon, authenticated;
grant select on table public.contact_phones to anon, authenticated;
grant all    on table public.contact_phones to service_role;

create policy "contact_phones_select_public" on public.contact_phones
  as permissive for select to anon, authenticated
  using (true);                     -- public reference data

create policy "contact_phones_deny_insert" on public.contact_phones
  as restrictive for insert to anon, authenticated with check (false);

create policy "contact_phones_deny_update" on public.contact_phones
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "contact_phones_deny_delete" on public.contact_phones
  as restrictive for delete to anon, authenticated using (false);

-- event_categories
alter table public.event_categories enable row level security;
revoke all on table public.event_categories from anon, authenticated;
grant select on table public.event_categories to anon, authenticated;
grant all    on table public.event_categories to service_role;

create policy "event_categories_select_public" on public.event_categories
  as permissive for select to anon, authenticated
  using (true);                     -- public reference data

create policy "event_categories_deny_insert" on public.event_categories
  as restrictive for insert to anon, authenticated with check (false);

create policy "event_categories_deny_update" on public.event_categories
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "event_categories_deny_delete" on public.event_categories
  as restrictive for delete to anon, authenticated using (false);

-- events
alter table public.events enable row level security;
revoke all on table public.events from anon, authenticated;
grant select on table public.events to anon, authenticated;
grant all    on table public.events to service_role;

create policy "events_select_public" on public.events
  as permissive for select to anon, authenticated
  using (is_published);                     -- published rows only

create policy "events_deny_insert" on public.events
  as restrictive for insert to anon, authenticated with check (false);

create policy "events_deny_update" on public.events
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "events_deny_delete" on public.events
  as restrictive for delete to anon, authenticated using (false);

-- exhibitions
alter table public.exhibitions enable row level security;
revoke all on table public.exhibitions from anon, authenticated;
grant select on table public.exhibitions to anon, authenticated;
grant all    on table public.exhibitions to service_role;

create policy "exhibitions_select_public" on public.exhibitions
  as permissive for select to anon, authenticated
  using (is_published);                     -- published rows only

create policy "exhibitions_deny_insert" on public.exhibitions
  as restrictive for insert to anon, authenticated with check (false);

create policy "exhibitions_deny_update" on public.exhibitions
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "exhibitions_deny_delete" on public.exhibitions
  as restrictive for delete to anon, authenticated using (false);

-- journeys
alter table public.journeys enable row level security;
revoke all on table public.journeys from anon, authenticated;
grant select on table public.journeys to anon, authenticated;
grant all    on table public.journeys to service_role;

create policy "journeys_select_public" on public.journeys
  as permissive for select to anon, authenticated
  using (is_published);                     -- published rows only

create policy "journeys_deny_insert" on public.journeys
  as restrictive for insert to anon, authenticated with check (false);

create policy "journeys_deny_update" on public.journeys
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "journeys_deny_delete" on public.journeys
  as restrictive for delete to anon, authenticated using (false);

-- news
alter table public.news enable row level security;
revoke all on table public.news from anon, authenticated;
grant select on table public.news to anon, authenticated;
grant all    on table public.news to service_role;

create policy "news_select_public" on public.news
  as permissive for select to anon, authenticated
  using (is_published);                     -- published rows only

create policy "news_deny_insert" on public.news
  as restrictive for insert to anon, authenticated with check (false);

create policy "news_deny_update" on public.news
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "news_deny_delete" on public.news
  as restrictive for delete to anon, authenticated using (false);

-- curated_themes
alter table public.curated_themes enable row level security;
revoke all on table public.curated_themes from anon, authenticated;
grant select on table public.curated_themes to anon, authenticated;
grant all    on table public.curated_themes to service_role;

create policy "curated_themes_select_public" on public.curated_themes
  as permissive for select to anon, authenticated
  using (is_published);                     -- published rows only

create policy "curated_themes_deny_insert" on public.curated_themes
  as restrictive for insert to anon, authenticated with check (false);

create policy "curated_themes_deny_update" on public.curated_themes
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "curated_themes_deny_delete" on public.curated_themes
  as restrictive for delete to anon, authenticated using (false);

-- curated_items
alter table public.curated_items enable row level security;
revoke all on table public.curated_items from anon, authenticated;
grant select on table public.curated_items to anon, authenticated;
grant all    on table public.curated_items to service_role;

create policy "curated_items_select_public" on public.curated_items
  as permissive for select to anon, authenticated
  using (is_published);                     -- published rows only

create policy "curated_items_deny_insert" on public.curated_items
  as restrictive for insert to anon, authenticated with check (false);

create policy "curated_items_deny_update" on public.curated_items
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "curated_items_deny_delete" on public.curated_items
  as restrictive for delete to anon, authenticated using (false);

-- collaborations
alter table public.collaborations enable row level security;
revoke all on table public.collaborations from anon, authenticated;
grant select on table public.collaborations to anon, authenticated;
grant all    on table public.collaborations to service_role;

create policy "collaborations_select_public" on public.collaborations
  as permissive for select to anon, authenticated
  using (is_published);                     -- published rows only

create policy "collaborations_deny_insert" on public.collaborations
  as restrictive for insert to anon, authenticated with check (false);

create policy "collaborations_deny_update" on public.collaborations
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "collaborations_deny_delete" on public.collaborations
  as restrictive for delete to anon, authenticated using (false);

-- pages
alter table public.pages enable row level security;
revoke all on table public.pages from anon, authenticated;
grant select on table public.pages to anon, authenticated;
grant all    on table public.pages to service_role;

create policy "pages_select_public" on public.pages
  as permissive for select to anon, authenticated
  using (true);                     -- public reference data

create policy "pages_deny_insert" on public.pages
  as restrictive for insert to anon, authenticated with check (false);

create policy "pages_deny_update" on public.pages
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "pages_deny_delete" on public.pages
  as restrictive for delete to anon, authenticated using (false);

-- page_blocks
alter table public.page_blocks enable row level security;
revoke all on table public.page_blocks from anon, authenticated;
grant select on table public.page_blocks to anon, authenticated;
grant all    on table public.page_blocks to service_role;

create policy "page_blocks_select_public" on public.page_blocks
  as permissive for select to anon, authenticated
  using (true);                     -- public reference data

create policy "page_blocks_deny_insert" on public.page_blocks
  as restrictive for insert to anon, authenticated with check (false);

create policy "page_blocks_deny_update" on public.page_blocks
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "page_blocks_deny_delete" on public.page_blocks
  as restrictive for delete to anon, authenticated using (false);

-- page_list_items
alter table public.page_list_items enable row level security;
revoke all on table public.page_list_items from anon, authenticated;
grant select on table public.page_list_items to anon, authenticated;
grant all    on table public.page_list_items to service_role;

create policy "page_list_items_select_public" on public.page_list_items
  as permissive for select to anon, authenticated
  using (true);                     -- public reference data

create policy "page_list_items_deny_insert" on public.page_list_items
  as restrictive for insert to anon, authenticated with check (false);

create policy "page_list_items_deny_update" on public.page_list_items
  as restrictive for update to anon, authenticated using (false) with check (false);

create policy "page_list_items_deny_delete" on public.page_list_items
  as restrictive for delete to anon, authenticated using (false);


commit;

-- -----------------------------------------------------------------------------
-- Post-apply verification (run manually; every row must read t / t / f):
--
--   select c.relname,
--          c.relrowsecurity                                    as rls_on,
--          has_table_privilege('anon', c.oid, 'SELECT')        as anon_can_read,
--          has_table_privilege('anon', c.oid, 'INSERT')
--       or has_table_privilege('anon', c.oid, 'UPDATE')
--       or has_table_privilege('anon', c.oid, 'DELETE')        as anon_can_write
--     from pg_class c
--     join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'r'
--    order by 1;
-- -----------------------------------------------------------------------------
