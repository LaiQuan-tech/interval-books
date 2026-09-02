-- 0029_event_seats_visibility.sql —— 「尚餘名額」改成逐場活動可以關掉
--
-- 前一支是 0028_free_order_settlement.sql。既有 0001–0028 一律不動（規約：已套用的
-- migration 永不修改），所以要加的東西都用這一支新的來加。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 這一支在補的洞
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 前台每一張場次卡片、以及商品頁價格旁的徽章，都**無條件**印出「尚餘名額 N」。
-- N 是 remainingForSession() 算出來的 `capacity - seats_taken`，而 capacity 是
-- NOT NULL（0020 §3）—— 也就是說「不限名額」在這個 schema 裡不是一個狀態。店家
-- 想表達「不限」的時候只能把 capacity 設得很寬鬆：正式庫那場 2026-09-05 的工作坊
-- 就是 capacity = 999。於是畫面上印出來的是「尚餘名額 999」——對客人不是資訊，
-- 看起來還像壞掉。
--
-- 但**不能**因此把這句話全站拿掉。名額真的緊的時候，「尚餘名額 2」是會影響報名
-- 決定的資訊。所以這是一個**逐場的編輯決定**，不是全站的行為 —— 這一欄就是那個
-- 決定的家。
--
-- 🔴 **「已額滿」不受這個開關影響。** 那是「你報不了名」，跟「還剩幾位」不是同一
--    件事：關掉名額顯示的活動額滿時，客人仍然必須看得出來，否則他會一直按一顆
--    按不動的按鈕。這條規則在 SQL 這一側沒有東西守得住（它是渲染規則），守在
--    scripts/event-registration-selftest.mjs 的 [11] 那一段。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 為什麼 events 與 products 兩張表都有這一欄
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 這一欄的**編輯位置**在活動後台（§4 報名與售票），所以它屬於 public.events。
-- 但**讀它的是前台的商品頁與活動頁**，而那兩頁的讀取層（src/lib/shop.ts）只讀
-- public.products 與 public.event_sessions，一個字都沒讀過 public.events。
--
-- 兩種帶過去的方式都評估過：
--
--   (a) 讓 shop.ts 反查 events。**不行，而且是三個獨立的理由**：
--       · products.source_id 對 events.id **沒有外鍵**（0004:44-45 是一組帶
--         discriminator 的普通欄位），所以 PostgREST 嵌不進來 —— 只能多打一趟
--         查詢再在 JS 裡自己 join。
--       · events 的 RLS 是 `using (is_published)`（0001:563-565）。一場**沒發布**
--         的活動，它的商品仍然可以是 active（那兩個開關互相獨立）。那時反查回來
--         是空的，旗標只能回落到預設值 —— 「單一真相」在最需要它的那個情況下剛好
--         失效。
--       · journey 型的商品**根本沒有 events 列**（它的 source_type 是 'journey'）。
--         它一樣有場次、一樣印「尚餘名額」，但這條路永遠管不到它。
--
--   (b) 投影到 products（本檔採用）。前台只要在既有的 select 多帶一欄，不新增
--       任何 anon 讀取路徑、不新增往返、不與 events 的 RLS 耦合，而且 journey 與
--       手動建立的商品自動吃到預設值。
--
-- ── 投影的代價：兩份會分岔的資料。這一支怎麼擋 ─────────────────────────────
--
-- 0026 §5 已經為同一類問題付過一次學費：products.slug = 'event-' || events.slug
-- 這條規則原本只在 admin_upsert_event_with_session() 裡成立，而活動後台還有一條
-- **只寫 public.events** 的普通儲存路徑（src/server/repos/events.ts#upsertEvent）。
-- 走那條路改了代稱，products 不會跟著改，前台就查不到商品了。0026 的答案是把
-- 它變成資料庫的事實：events_slug_sync_product trigger。
--
-- 這一欄有**兩個**方向會分岔，所以這裡放兩個守衛：
--
--   §3 events → products（trigger A）：改了活動的旗標就推給它的商品。擋的是
--      「只寫 events 的那條儲存路徑」，與 0026 §5 同一個形狀。
--
--   §4 products 被寫入時反向拉回（trigger B）：/admin/products 這個後台可以直接
--      建立／編輯一件 source_type='event' 的商品（src/server/repos/products.ts:136
--      真的會寫 source_type / source_id），所以商品那一側也有一條能造成分岔的路。
--      這個 trigger 讓「event 型商品的這一欄」變成**衍生值**：任何寫入都會被拉回
--      events 說的那個答案。兩個方向都堵住之後，分岔在資料庫層級就不可能發生。
--
-- 兩個 trigger 合起來的不變式：
--   ∀ p ∈ products where source_type='event' and ∃ e ∈ events where e.id=p.source_id
--     ⇒ p.show_seats_remaining = e.show_seats_remaining
-- §6 的回填讓這個不變式在套用當下就成立（而且重跑是 0 列）。
--
-- ⚠️ **不要把這一欄加進 /admin/products 的商品編輯表單。** 對 event 型商品它是
--    衍生值（§4 會把使用者填的值蓋掉），開一個改了沒用的欄位比沒有欄位更糟。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 冪等
-- ═══════════════════════════════════════════════════════════════════════════
-- 整支可以重複執行：add column if not exists / set default / set not null /
-- create or replace function / drop trigger if exists + create trigger /
-- 回填帶 `is distinct from` 條件（第二次是 0 列）。

begin;

-- ---------------------------------------------------------------------------
-- 1. public.events.show_seats_remaining —— 這個決定的家
-- ---------------------------------------------------------------------------
-- **default true**：預設顯示，維持這一支之前的行為。既有的每一場活動套用之後
-- 一個字都不會變 —— 要關掉是店家的一個明確動作。
alter table public.events
  add column if not exists show_seats_remaining boolean not null default true;

-- 下面三句是為了「欄位已經存在但形狀不對」的情況（有人手動加過、或上一次套到
-- 一半）。全新的資料庫上這三句都是 no-op。
alter table public.events
  alter column show_seats_remaining set default true;
update public.events
   set show_seats_remaining = true
 where show_seats_remaining is null;
alter table public.events
  alter column show_seats_remaining set not null;

comment on column public.events.show_seats_remaining is
  '前台要不要印出這場活動的「尚餘名額 N」。true（預設）＝ 顯示，維持 0029 之前的行為；false ＝ 不顯示。名額設得寬鬆（實務上等於「不限」）時，畫面上的「尚餘名額 999」對客人不是資訊。🔴 「已額滿」不受這個開關影響 —— 那是「你報不了名」，跟「還剩幾位」不是同一件事。會被投影到 products.show_seats_remaining（前台讀的是那一邊）。';

-- ---------------------------------------------------------------------------
-- 2. public.products.show_seats_remaining —— 前台真正讀到的那一份
-- ---------------------------------------------------------------------------
-- 對 source_type='event' 的商品，這一欄是 §1 的**投影**，由 §3／§4 兩個 trigger
-- 維持一致。對其他商品（journey、手動建立的活動商品）它就是這件商品自己的值，
-- 預設 true。
alter table public.products
  add column if not exists show_seats_remaining boolean not null default true;

alter table public.products
  alter column show_seats_remaining set default true;
update public.products
   set show_seats_remaining = true
 where show_seats_remaining is null;
alter table public.products
  alter column show_seats_remaining set not null;

comment on column public.products.show_seats_remaining is
  '前台（src/lib/shop.ts → SessionPicker / SessionList / StockBadge）要不要印出「尚餘名額 N」。source_type=''event'' 的商品上這是 events.show_seats_remaining 的衍生值，由 events_seats_visibility_sync_product 與 products_pull_seats_visibility 兩個 trigger 維持一致 —— 直接改這一欄對它們沒有用。0004 的 grant select 是表層級的，所以 anon 讀得到。';

-- ---------------------------------------------------------------------------
-- 3. trigger A：改了活動的旗標 → 推給它的商品
-- ---------------------------------------------------------------------------
-- 與 0026 §5 的 events_sync_product_slug() 是同一個形狀、同一個理由：活動後台還有
-- 一條**只寫 public.events** 的普通儲存路徑（src/server/repos/events.ts#upsertEvent，
-- 不上架的活動用它），沒有這個 trigger 的話，走那條路關掉的旗標永遠傳不到前台，
-- 而畫面上看起來就只是「這個開關沒有用」。
create or replace function public.events_sync_product_seats_visibility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.show_seats_remaining is distinct from old.show_seats_remaining then
    update public.products
       set show_seats_remaining = new.show_seats_remaining
     where source_type = 'event'
       and source_id   = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists events_seats_visibility_sync_product on public.events;
create trigger events_seats_visibility_sync_product
  after update of show_seats_remaining on public.events
  for each row execute function public.events_sync_product_seats_visibility();

-- 觸發器函式的 execute 權限只在**建立 trigger 的當下**檢查，觸發時不再檢查，所以
-- 收乾淨不影響上面那個 trigger 運作。與 0026:543 同一句。
revoke execute on function public.events_sync_product_seats_visibility()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. trigger B：寫入 event 型商品時，把旗標拉回 events 說的那個答案
-- ---------------------------------------------------------------------------
-- 這是 §3 的另一半。/admin/products 可以直接建立或編輯一件 source_type='event'
-- 的商品，那條路不經過 admin_upsert_event_with_session()，也不會碰 public.events。
-- 沒有這個 trigger 的話，那條路寫進來的值就是分岔的第二個真相。
--
-- 只在 insert、或 update 動到 (source_type, source_id, show_seats_remaining) 這三欄
-- 時才跑 —— 那正是**唯一**可能從商品這一側造成分岔的寫入集合。結帳路徑上的
-- `update products set stock = …` 不在其中，所以熱路徑不會多一次查詢。
--
-- 查不到對應的活動時**不覆蓋**（例如 source_id 指向一場已經被刪掉的活動）：那時
-- events 沒有答案可以給，硬寫一個預設值等於替不存在的東西發明一個決定。
create or replace function public.products_pull_seats_visibility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_show boolean;
begin
  if new.source_type = 'event' and new.source_id is not null then
    select e.show_seats_remaining into v_show
      from public.events e
     where e.id = new.source_id;
    if found then
      new.show_seats_remaining := v_show;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists products_pull_seats_visibility on public.products;
create trigger products_pull_seats_visibility
  before insert or update of source_type, source_id, show_seats_remaining
  on public.products
  for each row execute function public.products_pull_seats_visibility();

revoke execute on function public.products_pull_seats_visibility()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. admin_upsert_event_with_session() 多讀一個 key
-- ---------------------------------------------------------------------------
-- 🔴 **create or replace，不 drop。** 這支函式吃的是一個 payload jsonb，簽名沒變
--    —— 0026 就是為了這一天才這樣設計的（加欄位不必改簽名，也就不會留下兩支同名
--    overload 讓 PostgREST 挑錯）。drop function 會連帶把 grant 一起丟掉。
--
-- ⚠️ 底下的函式本體是 0027 §5 那一份**逐字照抄**，只多了三處與
--    show_seats_remaining 有關的改動（events 的 insert 值 + on conflict、products
--    的 insert 值 + on conflict、以及沒帶 "product" 那條 elsif 分支）。其餘一個字
--    都沒動 —— 這一支不是重寫那支函式的地方。
--
-- ⚠️ payload 沒帶 'show_seats_remaining' 這個 key 時**沿用資料庫裡的舊值**
--    （v_prev），不是蓋成 true。理由與 0027 的七個清單欄位同一條：前端漏送一個
--    key 不應該等於「使用者要求把名額顯示打開」。新增的活動兩邊都沒有值，才落到
--    true（＝ §1 的欄位預設）。

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

  -- 0027：七個清單欄位。payload 沒帶就沿用舊值，兩邊都沒有才用空清單。
  -- 0029：show_seats_remaining 也靠 v_prev 做「沒帶就不動」。
  v_prev      public.events%rowtype;
  c_empty_list constant jsonb := '{"zh": [], "en": [], "ja": []}'::jsonb;
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

  -- 0027：七個清單欄位。**沒帶那個 key 是合法的**（等於「這一欄不動」），但只要帶了
  -- 就一定要是 {zh:[],en:[],ja:[]} 的形狀。這裡先擋，是為了讓錯誤訊息點名是哪一欄
  -- ——不擋的話下面的 INSERT 會撞上 CHECK，使用者拿到的是一個 23514 與一串約束名。
  foreach v_key in array array[
    'highlights', 'suitable_for', 'not_suitable_for', 'takeaways',
    'outline', 'includes', 'notes'
  ] loop
    if (v_ev ? v_key) and not public.is_localized_list(v_ev -> v_key) then
      raise exception
        'admin_upsert_event_with_session: event.% 必須是 {"zh":[…],"en":[…],"ja":[…]} 三語清單（每一項都要是字串）', v_key;
    end if;
  end loop;

  -- ── 活動 ───────────────────────────────────────────────────────────────
  -- events.id 沒有 DB default（text primary key，見 0001_init.sql:175），所以新增
  -- 時要自己產一個。與 src/server/repos/events.ts 用 randomUUID() 是同一件事。
  v_event_id := nullif(trim(coalesce(v_ev ->> 'id', '')), '');
  if v_event_id is null then
    v_event_id := gen_random_uuid()::text;
  end if;

  -- 0027：先把舊的那一列讀出來，下面七個清單欄位「payload 沒帶就沿用舊值」要用它。
  -- 新增時查不到列，v_prev 的每一欄都是 NULL，coalesce 就落到空清單。
  select e.* into v_prev from public.events e where e.id = v_event_id;

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
    is_published, sort_order,
    highlights, suitable_for, not_suitable_for, takeaways, outline, includes, notes,
    show_seats_remaining
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
    coalesce((v_ev ->> 'sort_order')::integer, 0),
    coalesce(v_ev -> 'highlights',       v_prev.highlights,       c_empty_list),
    coalesce(v_ev -> 'suitable_for',     v_prev.suitable_for,     c_empty_list),
    coalesce(v_ev -> 'not_suitable_for', v_prev.not_suitable_for, c_empty_list),
    coalesce(v_ev -> 'takeaways',        v_prev.takeaways,        c_empty_list),
    coalesce(v_ev -> 'outline',          v_prev.outline,          c_empty_list),
    coalesce(v_ev -> 'includes',         v_prev.includes,         c_empty_list),
    coalesce(v_ev -> 'notes',            v_prev.notes,            c_empty_list),
    -- 0029：沒帶就沿用舊值，新增才落到 true。
    coalesce((v_ev ->> 'show_seats_remaining')::boolean, v_prev.show_seats_remaining, true)
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
    sort_order        = excluded.sort_order,
    highlights        = excluded.highlights,
    suitable_for      = excluded.suitable_for,
    not_suitable_for  = excluded.not_suitable_for,
    takeaways         = excluded.takeaways,
    outline           = excluded.outline,
    includes          = excluded.includes,
    notes             = excluded.notes,
    show_seats_remaining = excluded.show_seats_remaining
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
      requires_shipping, status, sort_order,
      show_seats_remaining
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
      coalesce((v_prod ->> 'sort_order')::integer, v_event.sort_order),
      -- 0029：與 image_key 同一類 —— 從活動投影過來，不是商品自己的決定。
      v_event.show_seats_remaining
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
      sort_order       = excluded.sort_order,
      show_seats_remaining = excluded.show_seats_remaining
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
           image_key   = v_event.image_key,
           show_seats_remaining = v_event.show_seats_remaining
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
  '一個交易內建立／更新一場活動、它的商品與（選填的）一個場次，回傳三者。吃 jsonb 而不是具名參數，因為 create or replace function 不能改簽名——加欄位就會留下兩支同名 overload 讓 PostgREST 挑錯。products.description 取 events.summary（不是 events.description），這條規則只有這一個家。0027 起也吃 events 的七個三語清單欄位；0029 起吃 show_seats_remaining（同樣是「payload 沒帶那個 key ＝那一欄不動」）。';

-- create or replace 會保留既有權限，這兩句是防守：萬一有人在別的地方 drop 過再建，
-- 這一支套完之後權限一定還是對的。
revoke execute on function public.admin_upsert_event_with_session(jsonb)
  from public, anon, authenticated;
grant  execute on function public.admin_upsert_event_with_session(jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. 回填：讓 §3／§4 的不變式在套用當下就成立
-- ---------------------------------------------------------------------------
-- 全新加上這兩欄的資料庫上，兩邊都是 true，這一句是 0 列。它是為了「欄位已經被
-- 手動加過、而且兩邊已經不一致」的情況 —— 那時 trigger 只管**未來**的寫入，過去
-- 留下的分岔要靠這一句掃掉。
--
-- `is distinct from` 讓重跑必然是 0 列（＝ 冪等，而且看得出來是冪等的）。
update public.products p
   set show_seats_remaining = e.show_seats_remaining
  from public.events e
 where p.source_type = 'event'
   and p.source_id   = e.id
   and p.show_seats_remaining is distinct from e.show_seats_remaining;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- 套用後的驗收（在 SQL editor 手動跑，不進 migration）
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1) 兩欄都在、都是 not null default true：
--   select table_name, column_name, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and column_name='show_seats_remaining';
--
-- 2) 兩個 trigger 都在：
--   select tgname, tgrelid::regclass from pg_trigger
--    where tgname in ('events_seats_visibility_sync_product','products_pull_seats_visibility');
--
-- 3) 不變式成立（應該回 0 列）：
--   select p.id from public.products p join public.events e on e.id = p.source_id
--    where p.source_type='event' and p.show_seats_remaining is distinct from e.show_seats_remaining;
--
-- 4) 那支 RPC 仍然只有 service_role 叫得動：
--   select has_function_privilege('anon','public.admin_upsert_event_with_session(jsonb)','execute');
--   -- 應為 false
