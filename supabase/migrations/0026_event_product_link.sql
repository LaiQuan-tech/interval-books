-- 0026_event_product_link.sql —— 活動與商品之間建立**真的**連結
--
-- 前一支是 0025_event_speaker.sql。既有 0001–0025 一律不動（規約：已套用的
-- migration 永不修改），所以要加的東西都用這一支新的來加。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 這一支在補的洞
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 目前「一場活動賣出去的那件商品」是靠慣例維持的：products 有一組
-- (source_type='event', source_id=events.id)，前台 /events/$slug 就用這一組去反查
-- （src/lib/shop.ts#fetchActiveProductForEvent）。這條線有三個洞：
--
--   1. **沒有唯一性保證。** 同一場活動可以有兩件商品指著它，資料庫不會攔。反查
--      那一支用 `.limit(1)` 取第一列 —— 也就是說「賣哪一件」取決於 sort_order
--      與 id 的排序，而不是取決於任何人的決定。
--   2. **沒有從後台建立商品的路。** 活動後台只寫 public.events，商品後台只寫
--      public.products，兩邊都不知道對方。要把一場活動變成可報名，得手動去商品頁
--      開一列、手動把 source_type / source_id 填對。填錯了沒有任何東西會說。
--   3. **products 的文案從哪裡來沒有規定。** 誰都可以自己決定要抄 events 的哪一欄，
--      於是同一件事會有兩套答案。
--
-- 這一支把三個洞一次補起來：唯一索引（1）、admin_upsert_event_with_session（2）、
-- 以及把「怎麼投影」寫死在那支函式裡（3）。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 events.slug 回填成 id —— 已經發出去的連結必須繼續有效
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 前台 /events/$slug 從第一天起就是用 events.id 當網址（public.events 本來沒有
-- slug 欄位，見 src/lib/cms.ts#fetchEventBySlug 的檔頭）。所以這一支的回填只有
-- 一種寫法是對的：
--
--     update public.events set slug = id;
--
-- events.id 是 text primary key、本來就唯一，回填成它就同時滿足唯一性，而且
-- **今天已經流出去的每一個網址在切換到 .eq("slug", slug) 之後仍然指到同一場活動**。
--
-- ⚠️ **不要試圖從 title 產生 slug。** 這個站的標題是中文，任何一種常見的
--    slugify（去掉非 ASCII 字元）套在「週五夜讀：城市的邊界」上得到的是**空字串**，
--    六場活動會得到六個一模一樣的空 slug，unique 索引當場炸掉。就算改用拼音，
--    產出來的東西也與已經發出去的網址無關 —— 那是換網址，不是補欄位。
--
-- ⚠️ **改代稱會讓已經發出去的連結 404。** 之後在後台可以把 slug 改成好看的代稱
--    （`ev-3` → `city-edges-night-read`），但那一刻起，舊網址就查不到東西了 ——
--    /events/$slug 對「查無此活動」是真的回 404（那是刻意的，見該路由檔頭）。
--    這句警告同時寫在後台 UI 上（src/routes/admin/_shell.events.tsx 的 slug 欄位）。
--    要改代稱，就要有人去把已經發出去的地方一起改掉。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 products.description 取 events.summary，不是 events.description
-- ═══════════════════════════════════════════════════════════════════════════
--
-- events 有兩個長文案欄位，它們不是同一種東西：
--
--   events.summary      —— 一兩句話。活動列表上那一行、活動詳情頁標題底下那一段。
--   events.description  —— 頁面級的引言，整段的活動介紹。
--
-- products.description 會出現在購物車、結帳頁與訂單信裡。把整段活動介紹塞進購物車
-- 的品項說明，讀起來就是一面牆。所以投影規則是 **products.description ←
-- events.summary**。
--
-- 這條規則**只有一個家**，就是下面那支函式。後台不准自己組 products 的 payload，
-- 前台不准自己再抄一次 —— 兩個家就是兩套答案，而它們會在沒有人注意的時候分岔。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 為什麼那支函式吃一個 payload jsonb，而不是二十個具名參數
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 因為 `create or replace function` **不能改參數的名字或型別**。加一個欄位就得改
-- 簽名，而改了簽名的 `create or replace` 不是取代那支函式，是**新建第二支同名
-- overload**。兩支同名不同簽名的函式並存時，PostgREST 依呼叫端送的 key 去挑，挑錯
-- 就是「舊那支被呼叫，新欄位被安靜丟掉」—— 沒有錯誤訊息，只有寫不進去的資料。
-- 要收拾就得 drop function，而 drop 會連帶把 grant / revoke 一起丟掉，於是又多一
-- 個「忘了補 revoke」的機會。
--
-- 吃一個 jsonb 就永遠不必走這條路：加欄位只是在 payload 裡多一個 key，簽名永遠是
-- `(payload jsonb)`。回傳也用 jsonb，理由一樣 —— `returns table (...)` 的形狀同樣
-- 不能被 create or replace 改掉（這個團隊已經踩過一次）。
--
-- 代價是型別檢查從編譯期挪到執行期。所以下面每一個必填 key 都自己驗，錯誤訊息裡
-- 帶著 key 的名字。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ 部署順序：這一支必須**先**套上 live DB，才能推程式碼
-- ═══════════════════════════════════════════════════════════════════════════
--
-- src/server/repos/events.ts 的 COLUMNS 會 select slug 與 image_key，
-- src/lib/cms.ts#fetchEventBySlug 會用 .eq("slug", …) 查詢。欄位還不存在時
-- PostgREST 回 42703 —— 後台整頁打不開，而且這一次連**前台活動詳情頁**也一起壞
-- （0025 那次只有後台壞，因為前台的欄位清單裡沒有 speaker_id；這一次前台要改用
-- slug 查詢，所以兩邊都吃得到）。
--
-- **先套 migration，再推程式碼。**
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 冪等
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 整支可以重複執行，而且第二次執行不會改變任何資料：
--   · 欄位用 add column if not exists
--   · 回填用 `where slug is null`（第二次是 0 列）
--   · 索引用 create [unique] index if not exists
--   · set not null 對已經 not null 的欄位是 no-op
--   · 函式與 trigger 用 create or replace / drop … if exists 再建
--
-- 唯一索引建立前先自己查一次有沒有既存的重複，並且用**點名 source_id** 的錯誤訊息
-- 中止 —— 直接讓 create unique index 去撞，拿到的只有 "could not create unique
-- index"，看不出是哪一場活動有兩件商品。

begin;

-- ---------------------------------------------------------------------------
-- 1. events.slug —— 網址代稱（回填 = id）
-- ---------------------------------------------------------------------------
alter table public.events
  add column if not exists slug text;

-- 回填。第二次執行是 0 列（slug 已經 not null，不可能還有 null）。
update public.events
   set slug = id
 where slug is null;

-- 唯一。events.id 本來就唯一，所以回填之後這一步不可能撞號 —— 除非有人在回填與
-- 建索引之間手動改過 slug，那就該炸。
create unique index if not exists events_slug_key
  on public.events (slug);

alter table public.events
  alter column slug set not null;

comment on column public.events.slug is
  '網址代稱，/events/<slug>。0026 回填成 id，所以在此之前發出去的每一個網址仍然有效。⚠️ 改這一欄會讓已經發出去的連結 404 —— /events/$slug 對查無此活動是真的回 404。products.slug 由 events_slug_sync_product trigger 跟著改成 event-<slug>。';

-- ---------------------------------------------------------------------------
-- 2. events.image_key —— 活動封面
-- ---------------------------------------------------------------------------
-- 可為 NULL，而且 NULL 是有意義的值：src/routes/events.$slug.tsx 目前刻意不畫封面，
-- 理由是 imageFor(key, fallback) 永遠會回一張圖，隨手帶一個不存在的 key 進去得到
-- 的不是「沒有封面」而是每一場活動都長一樣的那張假灰框。有了這一欄，「沒設圖」與
-- 「設了圖」才分得開。
--
-- 它會被投影到 products.image_key（見 §4）——「活動的封面」與「那件商品的圖」是
-- 同一張圖，不該讓店家上傳兩次。
alter table public.events
  add column if not exists image_key text;

comment on column public.events.image_key is
  '封面圖 key（bundled 檔名或 storage:… ）。NULL = 沒設，前台就不畫封面（不是畫一張假的佔位圖）。會被 admin_upsert_event_with_session() 投影到 products.image_key。';

-- ---------------------------------------------------------------------------
-- 3. 一場活動最多一件商品 —— 資料庫層級的事實
-- ---------------------------------------------------------------------------
-- 先點名既有的重複，再建索引。
do $$
declare
  v_dupes text;
begin
  select string_agg(source_id, ', ' order by source_id)
    into v_dupes
    from (
      select source_id
        from public.products
       where source_type = 'event'
         and source_id is not null
       group by source_id
      having count(*) > 1
    ) d;

  if v_dupes is not null then
    raise exception '0026 中止：這些活動同時掛著兩件以上的商品，唯一索引建不起來 —— %。請先到商品後台把多餘的那幾列改成 source_type=null（或刪掉），再重跑這一支。', v_dupes;
  end if;
end $$;

-- 部分唯一索引：只管 source_type='event' 的那些列，其他來源（journey /
-- curated_item）不受影響 —— 它們的基數規則不一定一樣，這一期沒有理由替它們決定。
--
-- 刻意**不**排除 status='archived'：products.slug 是 'event-' || events.slug（見 §4），
-- 那是從活動推導出來的**唯一**字串，所以「封存一件、再開一件新的」本來就做不到
-- （第二件會撞 products.slug 的唯一鍵）。一場活動對應到的那一列從頭到尾是同一列，
-- 上架與下架是改它的 status，不是換一列。
create unique index if not exists products_event_source_unique_idx
  on public.products (source_id)
  where source_type = 'event' and source_id is not null;

comment on index public.products_event_source_unique_idx is
  '一場活動最多一件商品。讓 src/lib/shop.ts 的反查不再依賴 .limit(1) 的排序運氣。';

-- ---------------------------------------------------------------------------
-- 4. event_product_slug —— 'event-' 這個前綴的唯一一個家（SQL 側）
-- ---------------------------------------------------------------------------
-- 兩個地方要算這個字串：下面的 upsert 函式（寫）與 §5 的 trigger（同步）。抽成
-- 函式是為了讓它們不可能分岔。
--
-- TS 側還有第三個地方要算它 —— src/lib/shop.ts#eventProductSlug()，因為前台
-- /events/$slug 要用它去**反查**。跨語言沒辦法共用一份實作，所以改由
-- scripts/event-product-selftest.mjs 把兩邊的前綴字面值釘在一起：任何一邊改了前綴
-- 而另一邊沒改，那條斷言會紅。
create or replace function public.event_product_slug(p_event_slug text)
returns text
language sql
immutable
set search_path = public
as $$
  select 'event-' || p_event_slug;
$$;

comment on function public.event_product_slug(text) is
  '活動商品的 slug 規則：event-<events.slug>。前台靠這個字串反查商品，所以它不是慣例而是介面。';

-- ---------------------------------------------------------------------------
-- 5. 改了 events.slug，products.slug 要跟著改
-- ---------------------------------------------------------------------------
-- 沒有這個 trigger 的話，「products.slug = event-<events.slug>」只有在有人記得
-- 走 admin_upsert_event_with_session() 的時候才成立 —— 而活動後台還有一條只寫
-- public.events 的普通儲存路徑（不上架的活動用它）。改了代稱卻沒重新上架，前台的
-- 反查就查不到東西，畫面上的樣子是「報名尚未開放」：**一句它其實不知道真假的話**。
--
-- 所以把它變成資料庫的事實。撞號（新的 event-<slug> 與別件商品的 slug 相同）會在
-- 這裡吃 23505 並讓整個 update 回滾 —— 那正是想要的：寧可存不進去，不要存進去一個
-- 前台查不到的狀態。
create or replace function public.events_sync_product_slug()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.slug is distinct from old.slug then
    update public.products
       set slug = public.event_product_slug(new.slug)
     where source_type = 'event'
       and source_id   = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists events_slug_sync_product on public.events;
create trigger events_slug_sync_product
  after update of slug on public.events
  for each row execute function public.events_sync_product_slug();

-- ---------------------------------------------------------------------------
-- 6. admin_upsert_event_with_session(payload jsonb) —— 一個交易，兩張表
-- ---------------------------------------------------------------------------
-- payload 的形狀（只有 event 是必填）：
--
--   {
--     "event": {
--       "id": "ev-3",                     -- 省略／空字串 = 新增
--       "slug": "ev-3",                   -- 省略時：更新沿用舊值，新增用 id
--       "title": {"zh":…,"en":…,"ja":…},  -- 必填
--       "summary": {...},                 -- 必填
--       "description": {...},             -- 必填
--       "display_date": "2026.05.24  Sat  19:30",
--       "iso_date": null,
--       "category": "lecture",
--       "speaker_id": null,               -- 空字串一律當成 null（見下）
--       "image_key": null,
--       "external_url": "https://…",
--       "registration_type": "internal",
--       "payment_enabled": true,
--       "is_published": true,
--       "sort_order": 3
--     },
--     "product": {                        -- 省略 = 不動商品那一列
--       "price": 500,
--       "compare_at_price": null,
--       "status": "active",               -- draft / active / archived，預設 active
--       "sort_order": 3                   -- 省略時沿用 event.sort_order
--     },
--     "session": {                        -- 省略 = 不動場次
--       "id": "…uuid…",                   -- 有 = 更新那一場；沒有 = 新增一場
--       "title": {...}, "location": {...},
--       "starts_at": "2026-05-24T19:30:00+08:00",
--       "ends_at": null,
--       "capacity": 20,
--       "status": "open",                 -- open / closed，預設 closed
--       "sort_order": 0
--     }
--   }
--
-- 回傳：{"event": {…列…}, "product": {…列…}|null, "session": {…列…}|null,
--        "session_count": N}
--
-- ⚠️ "product" 缺席與 "product": null 是同一件事（不動商品）。要下架就送
--    {"status": "archived"} —— 這支函式**不刪** products 列，理由見 0020 §1 那條
--    連鎖：賣出去過的活動商品刪不掉（order_items.session_id 是 on delete restrict），
--    刪除只會換到一個看不懂的 23503。
--
-- ⚠️ speaker_id 的空字串一律寫成 NULL。空字串不是合法的 artists.id，送出去只會吃
--    23503 —— 而後台下拉的「不指定」在某些送出路徑上就是空字串。這條規則在 TS 側
--    （src/server/repos/events.ts#upsertEvent）也有一份，兩邊都要有：走哪一條路徑
--    存進來的空字串都不可以變成外鍵違規。
create or replace function public.admin_upsert_event_with_session(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev        jsonb := payload -> 'event';
  v_prod      jsonb := payload -> 'product';
  v_sess      jsonb := payload -> 'session';

  v_event_id  text;
  v_slug      text;
  v_key       text;

  v_event     public.events%rowtype;
  v_product   public.products%rowtype;
  v_session   public.event_sessions%rowtype;

  v_prod_id   text;
  v_sess_id   uuid;
  v_count     integer;
begin
  -- ── 驗 payload ─────────────────────────────────────────────────────────
  -- jsonb 換來的彈性要用執行期檢查付回去。每一句都點名那個 key。
  if v_ev is null or jsonb_typeof(v_ev) <> 'object' then
    raise exception 'admin_upsert_event_with_session: payload 缺少 "event" 物件';
  end if;

  -- is_localized(null) 回 false（見 0001_init.sql:56），所以「key 不存在」與
  -- 「key 在但形狀不對」走同一條路，不需要先分開判斷。
  foreach v_key in array array['title', 'summary', 'description'] loop
    if not public.is_localized(v_ev -> v_key) then
      raise exception 'admin_upsert_event_with_session: event.% 必須是 {zh,en,ja} 三語物件', v_key;
    end if;
  end loop;

  foreach v_key in array array['display_date', 'category', 'external_url', 'registration_type'] loop
    if coalesce(trim(v_ev ->> v_key), '') = '' then
      raise exception 'admin_upsert_event_with_session: event.% 不可為空', v_key;
    end if;
  end loop;

  -- ── 活動 ───────────────────────────────────────────────────────────────
  -- events.id 沒有 DB default（text primary key，見 0001_init.sql:175），所以新增
  -- 時要自己產一個。與 src/server/repos/events.ts 用 randomUUID() 是同一件事。
  v_event_id := nullif(trim(coalesce(v_ev ->> 'id', '')), '');
  if v_event_id is null then
    v_event_id := gen_random_uuid()::text;
  end if;

  -- slug 省略時：更新沿用舊值（不會因為前端漏送就把代稱洗掉），新增用 id
  -- （＝ 0026 回填規則，見檔頭）。
  v_slug := nullif(trim(coalesce(v_ev ->> 'slug', '')), '');
  if v_slug is null then
    select e.slug into v_slug from public.events e where e.id = v_event_id;
    v_slug := coalesce(v_slug, v_event_id);
  end if;

  insert into public.events (
    id, slug, title, summary, description, display_date, iso_date, category,
    speaker_id, image_key, external_url, registration_type, payment_enabled,
    is_published, sort_order
  )
  values (
    v_event_id,
    v_slug,
    v_ev -> 'title',
    v_ev -> 'summary',
    v_ev -> 'description',
    v_ev ->> 'display_date',
    -- iso_date 是 date（不是 text）。空字串要先變 NULL 再轉型，
    -- 因為 ''::date 是 22007 而不是 NULL。
    nullif(trim(coalesce(v_ev ->> 'iso_date', '')), '')::date,
    v_ev ->> 'category',
    nullif(trim(coalesce(v_ev ->> 'speaker_id', '')), ''),
    nullif(trim(coalesce(v_ev ->> 'image_key', '')), ''),
    v_ev ->> 'external_url',
    v_ev ->> 'registration_type',
    coalesce((v_ev ->> 'payment_enabled')::boolean, false),
    coalesce((v_ev ->> 'is_published')::boolean, true),
    coalesce((v_ev ->> 'sort_order')::integer, 0)
  )
  on conflict (id) do update set
    slug              = excluded.slug,
    title             = excluded.title,
    summary           = excluded.summary,
    description       = excluded.description,
    display_date      = excluded.display_date,
    iso_date          = excluded.iso_date,
    category          = excluded.category,
    speaker_id        = excluded.speaker_id,
    image_key         = excluded.image_key,
    external_url      = excluded.external_url,
    registration_type = excluded.registration_type,
    payment_enabled   = excluded.payment_enabled,
    is_published      = excluded.is_published,
    sort_order        = excluded.sort_order
  returning * into v_event;

  -- ── 商品 ───────────────────────────────────────────────────────────────
  -- 先看這場活動已經有沒有商品（唯一索引保證最多一列）。有就更新那一列，沒有
  -- 而且 payload 帶了 "product" 才新建。
  select p.id into v_prod_id
    from public.products p
   where p.source_type = 'event'
     and p.source_id   = v_event.id;

  if v_prod is not null and jsonb_typeof(v_prod) = 'object' then
    if (v_prod ->> 'price') is null then
      raise exception 'admin_upsert_event_with_session: product.price 不可為空';
    end if;

    if v_prod_id is null then
      v_prod_id := gen_random_uuid()::text;
    end if;

    insert into public.products (
      id, slug, product_type, source_type, source_id,
      title, summary, description,
      price, compare_at_price, stock, capacity, image_key,
      requires_shipping, status, sort_order
    )
    values (
      v_prod_id,
      public.event_product_slug(v_event.slug),
      'event',
      'event',
      v_event.id,
      v_event.title,
      v_event.summary,
      -- 🔴 summary，不是 description。理由見檔頭；這是這條規則唯一的家。
      v_event.summary,
      (v_prod ->> 'price')::integer,
      nullif(trim(coalesce(v_prod ->> 'compare_at_price', '')), '')::integer,
      null,                                   -- stock：報名不是實體庫存
      null,                                   -- capacity：0020 起一律 null（名額在場次）
      v_event.image_key,
      false,                                  -- requires_shipping：報名不寄東西
      coalesce(nullif(trim(coalesce(v_prod ->> 'status', '')), ''), 'active'),
      coalesce((v_prod ->> 'sort_order')::integer, v_event.sort_order)
    )
    on conflict (id) do update set
      slug             = excluded.slug,
      title            = excluded.title,
      summary          = excluded.summary,
      description      = excluded.description,
      price            = excluded.price,
      compare_at_price = excluded.compare_at_price,
      image_key        = excluded.image_key,
      status           = excluded.status,
      sort_order       = excluded.sort_order
    returning * into v_product;

  elsif v_prod_id is not null then
    -- payload 沒帶 "product"，但這場活動已經有商品：文案仍然要跟著活動走，否則
    -- 改了活動標題，購物車裡還是舊的那一行。價格與上下架狀態**不動** —— 那兩個
    -- 是商品自己的決定，不是活動的屬性。
    update public.products p
       set slug        = public.event_product_slug(v_event.slug),
           title       = v_event.title,
           summary     = v_event.summary,
           description = v_event.summary,
           image_key   = v_event.image_key
     where p.id = v_prod_id
    returning * into v_product;
  end if;

  -- ── 場次 ───────────────────────────────────────────────────────────────
  if v_sess is not null and jsonb_typeof(v_sess) = 'object' then
    if v_product.id is null then
      raise exception 'admin_upsert_event_with_session: 要建場次就得先有商品 —— payload 缺少 "product"（場次掛在 products.id 上，見 0020）';
    end if;
    if (v_sess ->> 'capacity') is null then
      raise exception 'admin_upsert_event_with_session: session.capacity 不可為空（名額的唯一真相在場次上）';
    end if;

    v_sess_id := nullif(trim(coalesce(v_sess ->> 'id', '')), '')::uuid;

    if v_sess_id is null then
      insert into public.event_sessions (
        product_id, title, location, starts_at, ends_at, capacity, status, sort_order
      )
      values (
        v_product.id,
        v_sess -> 'title',
        v_sess -> 'location',
        (v_sess ->> 'starts_at')::timestamptz,
        nullif(trim(coalesce(v_sess ->> 'ends_at', '')), '')::timestamptz,
        (v_sess ->> 'capacity')::integer,
        coalesce(nullif(trim(coalesce(v_sess ->> 'status', '')), ''), 'closed'),
        coalesce((v_sess ->> 'sort_order')::integer, 0)
      )
      returning * into v_session;
    else
      -- ⚠️ seats_taken **不在**這裡更新。它由 reserve_session_seat() /
      --    release_session_seat() 在持有列鎖時維護（0020 §7），從表單寫回一個
      --    幾分鐘前讀到的計數器就是與那支 RPC 對撞。
      update public.event_sessions s
         set title      = v_sess -> 'title',
             location   = v_sess -> 'location',
             starts_at  = (v_sess ->> 'starts_at')::timestamptz,
             ends_at    = nullif(trim(coalesce(v_sess ->> 'ends_at', '')), '')::timestamptz,
             capacity   = (v_sess ->> 'capacity')::integer,
             status     = coalesce(nullif(trim(coalesce(v_sess ->> 'status', '')), ''), s.status),
             sort_order = coalesce((v_sess ->> 'sort_order')::integer, s.sort_order)
       where s.id = v_sess_id
         and s.product_id = v_product.id
      returning * into v_session;

      if v_session.id is null then
        raise exception 'admin_upsert_event_with_session: 找不到 session % （或它不屬於這場活動的商品）', v_sess_id;
      end if;
    end if;
  end if;

  select count(*)::integer into v_count
    from public.event_sessions s
   where v_product.id is not null
     and s.product_id = v_product.id;

  return jsonb_build_object(
    'event',         to_jsonb(v_event),
    'product',       case when v_product.id is null then null else to_jsonb(v_product) end,
    'session',       case when v_session.id is null then null else to_jsonb(v_session) end,
    'session_count', coalesce(v_count, 0)
  );
end;
$$;

comment on function public.admin_upsert_event_with_session(jsonb) is
  '一個交易內建立／更新一場活動、它的商品與（選填的）一個場次，回傳三者。吃 jsonb 而不是具名參數，因為 create or replace function 不能改簽名——加欄位就會留下兩支同名 overload 讓 PostgREST 挑錯。products.description 取 events.summary（不是 events.description），這條規則只有這一個家。';

-- SECURITY DEFINER 的函式一律不可以被前台的 key 呼叫。這一支會寫三張表，比
-- 0002 的 reorder 更不能外流。只有 service_role（＝已經通過 requireAdmin() 的
-- 伺服器函式）可以執行。
-- ⚠️ revoke 之後**一定要補上 grant to service_role**。`revoke … from public` 會把
--    service_role 從 PUBLIC 繼承來的那份 execute 一起收走，於是後台呼叫這支 RPC
--    會拿到 42501 —— 而 42501 的訊息長得像「權限設定錯了」，不像「少寫一行 grant」。
--    同一組 revoke/grant 見 0004_commerce_products.sql:236-239。
revoke execute on function public.admin_upsert_event_with_session(jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_upsert_event_with_session(jsonb)
  to service_role;

-- 觸發器函式的 execute 權限只在**建立 trigger 的當下**檢查，觸發時不再檢查，
-- 所以這一支收乾淨不影響 §5 的 trigger 運作。
revoke execute on function public.events_sync_product_slug()
  from public, anon, authenticated;

-- event_product_slug() 是純字串運算、immutable、不讀任何資料，而且前台本來就知道
-- 這個前綴（它要用它反查）。不 revoke。

commit;

-- 驗證（套用後請跑）：
--   -- slug 回填成 id、not null、唯一：
--   select count(*) filter (where slug is null)      as null_slug,
--          count(*) filter (where slug is distinct from id) as renamed,
--          count(*) as total
--     from public.events;
--
--   select indexname from pg_indexes
--    where schemaname='public' and tablename='events' and indexname='events_slug_key';
--
--   -- image_key 在不在：
--   select column_name, is_nullable from information_schema.columns
--    where table_schema='public' and table_name='events' and column_name='image_key';
--
--   -- 一場活動最多一件商品：
--   select indexname, indexdef from pg_indexes
--    where schemaname='public' and tablename='products'
--      and indexname='products_event_source_unique_idx';
--
--   -- 函式在不在，而且只有一支（兩支同名就是 overload 事故）：
--   select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.proname='admin_upsert_event_with_session';
--
--   -- anon / authenticated 不可以執行它：
--   select has_function_privilege('anon', 'public.admin_upsert_event_with_session(jsonb)', 'execute');
--   -- 必須是 f
