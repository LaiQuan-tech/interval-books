-- 0031_event_gallery.sql —— 活動相簿，外加順手修一個 external_url 的舊 bug
--
-- 前一支是 0030_customer_accounts.sql。既有 0001–0030 一律不動（規約：已套用的
-- migration 永不修改），所以要加的東西都用這一支新的來加。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 這一支在補的洞：活動詳情頁要有大圖與相簿，但「講者」不在這一支的範圍
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 需求原文是「活動頁面要有關於講者的版位介紹」「活動頁面也要有大圖片與更多照片」。
-- 後面那一半（大圖 + 相簿）這個 schema 目前真的沒有地方放，是這一支要補的洞。
--
-- 前面那一半（講者）**不需要新欄位**——public.events.speaker_id 早在
-- 0025_event_speaker.sql 就指到 public.artists(id)，而 public.artists 早在
-- 0019_vendors_pii_portal.sql 就有 name / discipline / bio / long_bio / image_key
-- 五欄，逐一對得上「姓名、頭銜、簡介、照片」。後台的活動編輯頁（
-- src/routes/admin/_shell.events.$id.tsx）也已經有一顆「主講人」下拉在選
-- speaker_id，旁邊那張 MirrorNote 卡片寫的原話就是「這場不顯示講者介紹」——
-- 這句話從那一期起就在畫面上，只是**前台從來沒有把它畫出來過**。
--
-- 也就是說「講者介紹版位」缺的只是 src/routes/events.$slug.tsx 那一頁的渲染，
-- 資料層與後台編輯都已經是現成的。這一支的職責只到資料庫這一層：加相簿欄位、
-- 讓 admin_upsert_event_with_session() 收得下它，並且修好 external_url 的 bug。
-- 前台渲染、後台相簿上傳 UI 是另外的、不動資料庫的改動，在同一個工作裡的
-- TypeScript 那一側完成。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 為什麼是 events.gallery_keys text[]，不是另開一張表
-- ═══════════════════════════════════════════════════════════════════════════
--
-- admin_upsert_event_with_session(payload jsonb) 從 0026 起就是為了「加欄位不必
-- drop function」而設計成吃一個 jsonb —— 這一支延續同一個設計：相簿是**一個
-- 有序的圖片 key 陣列**，跟 events 上其他「一場活動一份」的欄位（image_key、
-- 七個三語清單）同一種基數，用同一支 upsert 函式收，不必為它另開一張表、一支
-- reorder RPC、一組 RLS policy。
--
-- 陣列本身就帶著順序（Postgres array 的元素順序在讀寫之間穩定），所以「排序」
-- 是這一欄的值本身，不是另一個 sort_order 欄位——跟 events 上其他七個清單欄位
-- 用陣列索引當順序是同一個決定。
--
-- ── not null default '{}'，不是 nullable ──────────────────────────────────
-- 這一欄的角色跟 0027 那七個三語清單欄位一樣：「空 = 這一塊不畫」，不是
-- 「還沒填」。0027 訂的規則是 not null default 空清單，這裡照抄——nullable 版
-- 本要多一層 `coalesce(gallery_keys, '{}')` 才能安全比較長度，兩個地方
-- （SQL 這一支與 TypeScript 那一側）都要記得補，而且忘記補的那一刻不會報錯，
-- 只會在「沒設相簿的活動」上安靜地把 NULL 當成別的意思。not null default 讓
-- 「長度是不是 0」這個問題永遠只有一種問法。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 順手修：external_url 一律要求非空，是一個真的 bug
-- ═══════════════════════════════════════════════════════════════════════════
--
-- events.external_url 這一欄從 0001 起就是 `text not null`（沒有 CHECK 要求非空
-- 字串，NOT NULL 允許空字串），但 admin_upsert_event_with_session() 從 0026
-- 起就在 payload 驗證那一段把它跟 display_date / category / registration_type
-- 放在同一個「不可為空」的迴圈裡。這在活動改成站內報名（registration_type =
-- 'internal'）之後就是一個真的 bug：那種活動本來就沒有外部網址，
-- 2026-09 那一支把「前往活動網站」從列表頁拿掉的改動（見
-- src/routes/events.index.tsx 的相關 commit）也把好幾場活動的 external_url
-- 清成空字串——現在這五場活動只要打開後台儲存一次，就會撞上這支 RPC 自己訂的
-- 「不可為空」，存不回去。
--
-- 這一支把 external_url 從那個迴圈移出去，改成用 coalesce 補一個安全的空字串
-- （key 沒帶到的極端情況才會用到；活動後台的表單一律會送出這個 key，即使值是
-- 空字串）。src/lib/admin/schemas.ts 那一側的 zod 也有同一個 bug（
-- registrationFields.external_url 原本是 z.string().url()，一律要求合法網址），
-- 在同一個改動裡一起放寬——只放寬這一支 SQL 而不動 zod 的話，後台表單會在
-- 送出前就被攔下來，這支 RPC 的修法永遠不會被呼叫到，bug 等於沒修。zod 那一側
-- 改用的是這個檔案裡已經有的先例（portal_url / collaborations.external_url 的
-- `v === "" || /^https?:\/\//.test(v)`），不是新發明的驗證方式。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ 部署順序：這一支必須**先**套上 live DB，才能推含有 gallery_keys 的程式碼
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 這是這個 repo 第四次踩到同一條規則了（0025 的 speaker_id、0026 的 slug /
-- image_key、0027 的七個清單欄位）。這一次的差異面比較小：
--
--   · src/lib/cms.ts#fetchEventBySlug() 會 select gallery_keys（外加 image_key
--     與 speaker_id——這兩欄本來就存在，只是這一頁從第一天就刻意不 select，
--     這一期起才真的讀）。欄位不存在時 PostgREST 回 42703，活動詳情頁 500。
--   · src/routes/admin/_shell.events.$id.tsx 的相簿欄位會送 gallery_keys 給
--     admin_upsert_event_with_session()；RPC 還沒吃這個 key 的話，欄位會被
--     這一支 0031 之前的版本忽略（jsonb 的彈性——多送一個 key 不會報錯，
--     只會被安靜丟掉），存了跟沒存一樣。
--
-- **先套 migration，再推程式碼。**
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 冪等
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 整支可以重複執行：欄位用 add column if not exists；函式用 create or replace。
-- 沒有需要回填的既有資料——gallery_keys 的欄位預設本身就是正確的「沒有相簿」。

begin;

-- ---------------------------------------------------------------------------
-- 1. public.events.gallery_keys —— 相簿，一個有序的圖片 key 陣列
-- ---------------------------------------------------------------------------
-- 陣列裡每一個元素都是 image_key 慣例下的值：bundled 檔名，或
-- `storage:<uuid>.webp` 這種指到 Supabase Storage 的 key（src/lib/images.ts
-- 的 imageFor() 認得這兩種）。**不會**是完整網址，跟 events.image_key 同一種
-- 值、同一支解析函式。
alter table public.events
  add column if not exists gallery_keys text[] not null default '{}'::text[];

comment on column public.events.gallery_keys is
  '活動相簿：一個有序的圖片 key 陣列（每一項是 image_key 慣例下的值，見 src/lib/images.ts#imageFor）。not null default 空陣列——空陣列＝前台這一塊不畫，不是「還沒填」，與 0027 那七個三語清單欄位同一條規則。陣列的元素順序就是前台顯示順序，這一欄本身不必再配一個 sort_order。只透過 admin_upsert_event_with_session(payload jsonb) 寫入。';

-- ---------------------------------------------------------------------------
-- 2. admin_upsert_event_with_session(payload jsonb) —— 多吃一個 key，並放寬
--    external_url 的驗證
-- ---------------------------------------------------------------------------
-- 🔴 **create or replace，不 drop。** 這支函式吃的是一個 payload jsonb，簽名沒變
--    ——0026 就是為了這一天才這樣設計的（加欄位不必改簽名，也就不會留下兩支同名
--    overload 讓 PostgREST 挑錯）。drop function 會連帶把 grant 一起丟掉。
--
-- ⚠️ 底下的函式本體是 0029 §5 那一份**逐字照抄**，只有三處改動：
--      1. payload 驗證那段的「不可為空」迴圈拿掉 external_url。
--      2. events 的 insert 值把 external_url 從 `v_ev ->> 'external_url'`
--         改成 `coalesce(v_ev ->> 'external_url', '')`——拿掉強制非空之後，
--         key 沒帶到時原本的寫法會插入 SQL NULL，撞上 events.external_url 的
--         NOT NULL 約束；coalesce 補一個空字串才是「允許空值」真正的意思。
--      3. gallery_keys 的驗證、宣告、insert 值、on conflict 更新，四處都是
--         新增，插在 image_key 附近（events 上另一個圖片相關欄位）。
--    其餘一個字都沒動——這一支不是重寫那支函式的地方。
--
-- ⚠️ gallery_keys 沒帶那個 key 時**沿用資料庫裡的舊值**（v_prev），不是清成
--    空陣列。理由與 0027 的七個清單欄位、0029 的 show_seats_remaining 同一條：
--    前端漏送一個 key 不應該等於「使用者要求清空相簿」。新增的活動兩邊都沒有
--    值，才落到空陣列（＝ §1 的欄位預設）。要清空相簿是一個看得見的動作：送
--    `"gallery_keys": []`。
--
-- ⚠️ gallery_keys 帶了但形狀不對（不是 JSON 陣列，或陣列裡有非字串元素）
--    會被點名擋下來，不是讓底下的型別轉換丟一個看不懂的錯誤。跟七個清單欄位
--    「帶了但形狀不對就擋下來」是同一個決定（見下面「帶了但形狀不對」那一句
--    註解）。

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
  -- 0031：gallery_keys 同一條規則，但型別是 text[] 不是 jsonb，所以另外用
  --       v_gallery_keys 這個區域變數算好再放進 insert，不能沿用那一行
  --       coalesce(jsonb, jsonb, jsonb) 的寫法。
  v_prev      public.events%rowtype;
  c_empty_list constant jsonb := '{"zh": [], "en": [], "ja": []}'::jsonb;
  v_gallery_keys text[];
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

  -- 🔴 0031：external_url 從這個迴圈拿掉了。它仍然是 events 的 NOT NULL 欄位，
  --    但「不可為空」是這支函式自己加的規則，不是資料庫的規則——而且這條規則
  --    擋住了 5 場已經把外部連結清空的活動（見檔頭）。display_date / category /
  --    registration_type 三個維持原樣：它們是真的不能省略的欄位。
  foreach v_key in array array['display_date', 'category', 'registration_type'] loop
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

  -- 0031：gallery_keys。**沒帶那個 key 是合法的**（等於「這一欄不動」），但帶了
  -- 就一定要是一個字串陣列——同一個「先擋、點名哪一欄」的理由。
  if (v_ev ? 'gallery_keys') then
    if jsonb_typeof(v_ev -> 'gallery_keys') <> 'array' then
      raise exception 'admin_upsert_event_with_session: event.gallery_keys 必須是字串陣列';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_ev -> 'gallery_keys') as elem
       where jsonb_typeof(elem) <> 'string'
    ) then
      raise exception 'admin_upsert_event_with_session: event.gallery_keys 的每一項都必須是字串';
    end if;
  end if;

  -- ── 活動 ───────────────────────────────────────────────────────────────
  -- events.id 沒有 DB default（text primary key，見 0001_init.sql:175），所以新增
  -- 時要自己產一個。與 src/server/repos/events.ts 用 randomUUID() 是同一件事。
  v_event_id := nullif(trim(coalesce(v_ev ->> 'id', '')), '');
  if v_event_id is null then
    v_event_id := gen_random_uuid()::text;
  end if;

  -- 0027：先把舊的那一列讀出來，下面七個清單欄位與 0031 的 gallery_keys
  -- 「payload 沒帶就沿用舊值」要用它。新增時查不到列，v_prev 的每一欄都是
  -- NULL，coalesce 就落到空清單／空陣列。
  select e.* into v_prev from public.events e where e.id = v_event_id;

  -- 0031：gallery_keys 從 jsonb 陣列轉成 text[]。空字串元素順手濾掉——跟這個
  -- repo 到處都在做的 `nullif(trim(...), '')` 是同一個防線，只是這裡是陣列
  -- 版本。
  if v_ev ? 'gallery_keys' then
    select coalesce(array_agg(x) filter (where length(trim(x)) > 0), '{}'::text[])
      into v_gallery_keys
      from jsonb_array_elements_text(v_ev -> 'gallery_keys') x;
  else
    v_gallery_keys := coalesce(v_prev.gallery_keys, '{}'::text[]);
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
    is_published, sort_order,
    highlights, suitable_for, not_suitable_for, takeaways, outline, includes, notes,
    show_seats_remaining, gallery_keys
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
    -- 🔴 0031：coalesce 到空字串，不是任由 NULL 撞上 NOT NULL——見檔頭「順手修」。
    coalesce(v_ev ->> 'external_url', ''),
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
    coalesce((v_ev ->> 'show_seats_remaining')::boolean, v_prev.show_seats_remaining, true),
    -- 0031：上面算好的區域變數，理由見宣告處。
    v_gallery_keys
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
    show_seats_remaining = excluded.show_seats_remaining,
    gallery_keys      = excluded.gallery_keys
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
  '一個交易內建立／更新一場活動、它的商品與（選填的）一個場次，回傳三者。吃 jsonb 而不是具名參數，因為 create or replace function 不能改簽名——加欄位就會留下兩支同名 overload 讓 PostgREST 挑錯。products.description 取 events.summary（不是 events.description），這條規則只有這一個家。0027 起也吃 events 的七個三語清單欄位；0029 起吃 show_seats_remaining（同樣是「payload 沒帶那個 key ＝那一欄不動」）；0031 起吃 gallery_keys（同一條「沒帶就不動」規則，型別是 text[]），並且 external_url 允許空字串（那一欄的 NOT NULL 沒有變，變的是這支函式自己原本多加的「不可為空」）。';

-- create or replace 會保留既有權限，這兩句是防守：萬一有人在別的地方 drop 過再建，
-- 這一支套完之後權限一定還是對的。
revoke execute on function public.admin_upsert_event_with_session(jsonb)
  from public, anon, authenticated;
grant  execute on function public.admin_upsert_event_with_session(jsonb)
  to service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- 套用後的驗收（在 SQL editor 手動跑，不進 migration）
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1) gallery_keys 在、型別是 text[]、not null、預設空陣列：
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='events' and column_name='gallery_keys';
--
-- 2) 既有活動套用後 gallery_keys 全是空陣列（不是 NULL）：
--   select count(*) filter (where gallery_keys is null) as null_count,
--          count(*) filter (where gallery_keys = '{}') as empty_count,
--          count(*) as total
--     from public.events;
--   -- null_count 應為 0，empty_count 應等於 total（套用當下沒有人已經填過相簿）。
--
-- 3) 那支 RPC 仍然只有 service_role 叫得動：
--   select has_function_privilege('anon','public.admin_upsert_event_with_session(jsonb)','execute');
--   -- 應為 false
--
-- 4) external_url 允許空字串（拿一場 registration_type='internal' 的既有活動試填空字串
--    存一次，不應該再撞上「event.external_url 不可為空」）。
