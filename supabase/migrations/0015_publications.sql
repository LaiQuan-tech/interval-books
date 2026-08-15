-- 0015_publications.sql —— 地方刊物展的 126 本刊物
--
-- ── 為什麼是一張新表，而不是塞進 exhibitions ────────────────────────────────
-- public.exhibitions 的一列是「一檔展覽」：有展期、有地點、首頁會拿 slug 當錨點。
-- 這 126 本是那一檔展覽的**內容物**，兩者不是同一種東西 —— 硬塞進去的話，
-- 「展期」與「地點」對每一本刊物都得填一個假值，而首頁會突然多出 126 個錨點。
--
-- ── 為什麼也不是塞進 products ──────────────────────────────────────────────
-- 126 本裡目前只有一小部分賣得動（見下面 product_id 的說明）。若把「展示」和
-- 「販售」壓成同一張表，那 100 多本沒有定價、沒有庫存的刊物就只能以
-- status='draft' 存在 —— 而 draft 的意思是「還沒做完」，不是「這本只展不賣」。
-- 展覽頁要拿得到它們，就得放寬 products 的 RLS，那是拿電商的安全邊界換排版。
--
-- ── 這張表與 products 的關係：一條可有可無的線 ──────────────────────────────
-- product_id 可為 NULL。NULL＝這本只在展覽頁上展示（前台顯示「店內展示」）；
-- 非 NULL＝這本連到了一件型錄商品，前台就長出購買鈕，可售量走既有的
-- public.product_availability（0011），下單保留走 reserve_inventory_stock()。
--
-- 「之後補完定價再上架」因此**不是一次資料遷移**，而是後台的一個動作：
-- /admin/publications 挑一個進銷存品項、填價格 → 沿用 0011/0012 既有的上架路徑
-- 建 products + product_inventory_links → 回填這裡的 product_id。前台立刻可買，
-- 這張表的形狀一個字都不用改。
--
-- 前一個 migration：0014_pos_counter.sql。既有 0001–0014 一律不動。

begin;

-- ---------------------------------------------------------------------------
-- publications
-- ---------------------------------------------------------------------------
-- 三個 jsonb 欄位與全站其他表一致：{zh,en,ja}，過 0001 的 is_localized() CHECK。
-- 這不是可選的 —— 站上有中英日三個版本，而語言切換是靠 t(row.title) 直接取鍵，
-- 少一個語言就是那一語的畫面上出現空白。
--
-- 其餘欄位刻意都是**原始資料的形狀**，不做正規化：
--   region  —— 「關注地域」是自由文字（「基隆-八斗子」「日本全國」「南部農漁村」
--              都是原文），拆成縣市／鄉鎮兩欄的話，那三種都會被迫填假值。
--              前台的地域篩選是把這串文字歸類到粗分類，歸類規則寫在 TypeScript
--              裡（src/lib/publications.ts#REGION_GROUPS），改規則不用改資料。
--   issues  —— 「集數」在原始資料裡是「2016 秋、2017 秋、2018 春」這種人寫的字串，
--              不是數字。可為 NULL（10 本沒填）。
--   sheet   —— 原始 Excel 的兩張工作表，'tw' / 'jp'。前台的第一層篩選就是它。
--   seq     —— 原始表裡的列序。與 sheet 合起來唯一，是回頭對照原始檔的唯一憑據。
create table if not exists public.publications (
  id              text primary key,

  -- 網址代稱／錨點。刊物名稱**不唯一**（原始資料裡「季刊にゃー」有 5 筆、
  -- 「BEEK」有 2 筆），所以 slug 由 sheet+seq 生成而不是由標題生成。
  slug            text not null unique,

  sheet           text not null check (sheet in ('tw', 'jp')),
  seq             integer not null check (seq > 0),

  title           jsonb not null,
  publisher       jsonb not null,
  intro           jsonb not null,

  region          text not null default '',
  issues          text,
  external_url    text,

  -- 'storage:<uuid>.jpg'（0003 的 site-images bucket）或 NULL。與 exhibitions.image_key
  -- 同一套語意，由 src/lib/images.ts#imageFor() 解析。
  cover_image_key text,

  -- 選配：連到一件可買的型錄商品。on delete set null —— 商品被下架時，刊物要
  -- 留在展覽頁上（只是不能買了），不該跟著消失。
  product_id      text references public.products (id) on delete set null,

  is_published    boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint publications_title_localized     check (public.is_localized(title)),
  constraint publications_publisher_localized check (public.is_localized(publisher)),
  constraint publications_intro_localized     check (public.is_localized(intro)),

  -- 回頭對照原始 Excel 的唯一鍵，也擋掉重複匯入。
  constraint publications_sheet_seq_unique unique (sheet, seq)
);

comment on table public.publications is
  '地方刊物展的展品：126 本台灣／日本地方刊物。product_id 非 NULL 的那幾本可以買，其餘只展示。';
comment on column public.publications.slug is
  '由 sheet+seq 生成（tw-001…），不是由標題生成 —— 刊物名稱在原始資料裡並不唯一。';
comment on column public.publications.region is
  '「關注地域」，原文照抄的自由文字。前台的粗分類在 src/lib/publications.ts，不在這裡。';
comment on column public.publications.issues is
  '「集數」，人寫的字串（例：「2016 秋、2017 秋、2018 春」），不是數字。';
comment on column public.publications.product_id is
  'NULL = 只展示。非 NULL = 前台長出購買鈕，可售量走 public.product_availability。';

-- 一本刊物對一件商品。少了這個，兩本刊物可以指向同一件商品，而那件商品的庫存
-- 會在兩個地方各被賣一次，報表上分不出賣掉的是哪一本。
-- （Postgres 的 unique 允許多個 NULL，所以「沒連結」的那 100 多本不受影響。）
create unique index if not exists publications_product_unique
  on public.publications (product_id)
  where product_id is not null;

-- 前台一次讀全部，照 (sheet, sort_order) 排；後台列表同一條路徑。
create index if not exists publications_sheet_sort_idx
  on public.publications (sheet, sort_order, seq);

create index if not exists publications_published_idx
  on public.publications (is_published)
  where is_published;

drop trigger if exists publications_set_updated_at on public.publications;
create trigger publications_set_updated_at
  before update on public.publications
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 權限
-- ---------------------------------------------------------------------------
-- ⚠️ revoke 才是真正生效的那一半。Supabase 對 public schema 的新物件有預設全開的
--    ALTER DEFAULT PRIVILEGES，只下 grant select 的話，anon 實際拿到的是
--    DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE —— 0013 就是在修
--    product_availability 踩到的這個坑。這裡先 revoke all 再明確 grant select。
--
-- RLS 與 0001 的每一張內容表同一套：anon/authenticated 只讀已發布的列，三條
-- restrictive 政策把寫入釘死。寫入一律走 service_role（後台的 server functions）。
alter table public.publications enable row level security;
revoke all on table public.publications from anon, authenticated;
grant select on table public.publications to anon, authenticated;
grant all    on table public.publications to service_role;

drop policy if exists publications_select_public on public.publications;
create policy publications_select_public on public.publications
  as permissive for select to anon, authenticated
  using (is_published);

drop policy if exists publications_deny_insert on public.publications;
create policy publications_deny_insert on public.publications
  as restrictive for insert to anon, authenticated with check (false);

drop policy if exists publications_deny_update on public.publications;
create policy publications_deny_update on public.publications
  as restrictive for update to anon, authenticated using (false) with check (false);

drop policy if exists publications_deny_delete on public.publications;
create policy publications_deny_delete on public.publications
  as restrictive for delete to anon, authenticated using (false);

-- ---------------------------------------------------------------------------
-- publication_listing_candidates —— 後台「把這本連到庫存商品」的候選清單
-- ---------------------------------------------------------------------------
-- 與 0012 的 inv_listing_candidates 是**同一個問題的兩種問法**，所以刻意建在它
-- 上面而不是重寫一次 inv 的查詢：那三個條件（is_active / approved / 有庫存）是
-- 進銷存自己對「現在可以賣」的定義，只該有一份。
--
-- 這裡多做的只有一件事：把品名拿去跟刊物標題比對，算出一個 name_matches 旗標，
-- 讓後台的下拉選單能把「跟這本同名的品項」排在最前面。比對用的正規化只去掉
-- 空白與標點 —— **刻意不做模糊比對**：猜錯的連結會讓客人買到另一本刊物，而
-- 那個錯誤在出貨之前沒有任何地方看得出來。剩下的交給人選。
create or replace view public.publication_listing_candidates
with (security_invoker = false) as
select
  c.inv_product_id,
  c.name,
  c.selling_price,
  c.stock_quantity,
  c.pack_size,
  c.barcode,
  p.id as publication_id
from public.inv_listing_candidates c
cross join public.publications p
where regexp_replace(lower(c.name), '[^[:alnum:]]', '', 'g')
    = regexp_replace(lower(p.title ->> 'zh'), '[^[:alnum:]]', '', 'g')
   or regexp_replace(lower(c.name), '[^[:alnum:]]', '', 'g')
    = regexp_replace(lower(p.title ->> 'ja'), '[^[:alnum:]]', '', 'g');

comment on view public.publication_listing_candidates is
  '進銷存品項中與某本刊物同名的那些（正規化後完全相等，不做模糊比對）。只給 service_role，因為它讀的是 inv。';

-- 與 0012 的兩個 view 同一條線：只給 service_role，anon 與 authenticated 一個字
-- 都讀不到（它底下是 inv）。
revoke all on public.publication_listing_candidates from anon, authenticated;
grant select on public.publication_listing_candidates to service_role;

commit;
