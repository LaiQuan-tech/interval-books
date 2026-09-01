-- 0027_event_blocks.sql —— 活動頁組裝器的**資料層**（D1）
--
-- 前一支是 0026_event_product_link.sql。既有 0001–0026 一律不動（規約：已套用的
-- migration 永不修改），所以要加的東西都用這一支新的來加。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 這一期要換掉的東西
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 今天一場活動的內容只有 title / summary / description 三塊，其中 description 是
-- 一坨自由文字。店家想寫「這場適合誰、會帶走什麼、19:30 入場 19:40 開場、費用含
-- 一杯飲料、遲到怎麼辦」，只能全部塞進那一坨裡，前台也只能原樣印出來。
--
-- 這一期把那一坨拆成**由上到下可以組裝的一頁**：後台段落的順序就是前台區塊的順序，
-- **某一段留空，前台那一整塊就消失**。留空是關掉，不是「還沒填」——所以每一個清單
-- 欄位都是 not null default 三個空陣列，而不是 nullable。
--
-- 這一支只做資料層。後台 UI 與前台渲染是後面幾期的事；那幾期不需要再開 migration。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 為什麼是「七個 jsonb 清單欄位」而不是別的三種做法
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ✗ **21 個 text[]**（highlights_zh / highlights_en / highlights_ja × 7）。
--   會把一個概念炸成三個彼此不知道對方存在的欄位。更要命的是後台那顆已經在跑的
--   自動翻譯鈕：它的形狀是「一個欄位名 → 一個 {zh,en,ja} 物件」
--   （src/components/admin/LocalizedListField.tsx），三個獨立欄位綁不上去，等於要
--   為這七欄再寫一套翻譯流程。
--
-- ✗ **七張獨立子表**（或一張 event_list_items 掛 list_key）。這個 schema 已經有一套
--   「有序的三語字串清單」機制了 —— page_list_items（0001）。再開一套，之後每次改
--   排序、改翻譯、改上限都要問「這是哪一套的清單」。
--
-- ✓ **jsonb {"zh":[…],"en":[…],"ja":[…]}**。與全站每一個三語欄位同一個形狀，翻譯鈕
--   直接吃，一個欄位一個概念。代價是 SQL 這一側只保護得了**形狀**——見下面的分工。
--
-- ── 資料庫管形狀，zod 管內容 ──────────────────────────────────────────────
-- 這條分工是既有的（src/lib/admin/schemas.ts 檔頭寫著）：
--   · 資料庫：是不是物件、三個 key 在不在、每個 key 是不是陣列、元素是不是字串。
--   · zod：最多幾項（40）、每項最多幾字（200）、可不可以是空字串。
-- 上限寫在 src/lib/admin/localized-list.ts，那裡是唯一的家；這裡不重打一次數字。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 為什麼新開 is_localized_list()，而不是把 0001 的 is_localized() 改嚴
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0001 的 is_localized() 只檢查 zh / en / ja 三個 key **存在**，不管值是什麼型別。
-- 對它原本要守的那些欄位（title、summary…都是字串）夠用，但拿來守清單欄位會漏掉
-- 最容易發生、也最難發現的那一種壞資料：
--
--     {"zh": "一行\n一行", "en": [], "ja": []}
--
-- 前台對一個**字串** .map() 不會噴錯，它會得到一份**逐字元**的清單 —— 畫面上是
-- 每個字一個項目符號。沒有任何錯誤訊息，只有一頁看起來壞掉的活動。
--
-- 兩個理由不改 is_localized()：
--   1. **規約**：0001 已經套用，一行都不能動。
--   2. **就算能動也不該動**：那支函式被 25 個以上的 CHECK 用著，改嚴它會讓每一張
--      表重新驗證（ALTER 會掃全表），而且那些欄位本來就該是字串——改嚴它是在替
--      別人的欄位做決定。
--
-- 所以新開一支，只給這七欄用。舊的那支繼續守舊的那些欄位。

begin;

-- ---------------------------------------------------------------------------
-- 1. is_localized_list() —— 三語清單的形狀守門
-- ---------------------------------------------------------------------------
-- 🔴 這支函式**永遠不可以回 NULL**。CHECK 約束把 NULL 當成通過，所以一支會在
--    「key 不存在」時回 NULL 的守門函式，等於對那一種壞資料完全沒有防守 ——
--    而那正是最常見的一種。coalesce(jsonb_typeof(…), '') 與 CASE 都是為了這件事：
--    每一條路都明確地回 true 或 false。
--
-- ⚠️ 用 CASE 而不是一串 AND，也是為了同一件事的另一半：jsonb_array_elements() 對
--    非陣列會**丟例外**（22023），不是回 false。一串 AND 的求值順序沒有保證，
--    「先確定是陣列、才去展開它」這件事只有 CASE 排得出來。丟例外與回 false 的
--    差別是使用者看到 23514（違反 CHECK，前台看得懂）還是一個 22023 的 500。
create or replace function public.is_localized_list(v jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when v is null                                        then false
    when jsonb_typeof(v) <> 'object'                      then false
    when coalesce(jsonb_typeof(v -> 'zh'), '') <> 'array' then false
    when coalesce(jsonb_typeof(v -> 'en'), '') <> 'array' then false
    when coalesce(jsonb_typeof(v -> 'ja'), '') <> 'array' then false
    else not exists (
      select 1
        from (
          select jsonb_array_elements(v -> 'zh') as item
          union all
          select jsonb_array_elements(v -> 'en')
          union all
          select jsonb_array_elements(v -> 'ja')
        ) e
       where jsonb_typeof(e.item) <> 'string'
    )
  end;
$$;

comment on function public.is_localized_list(jsonb) is
  '三語清單的形狀守門：物件、zh/en/ja 三個 key 都是陣列、每個元素都是字串。與 0001 的 is_localized() 是兩支不同的函式——後者只檢查三個 key 存在，所以一個字串也會過，而前台對字串 .map() 會得到逐字元清單。長度上限與非空由 zod 管（src/lib/admin/schemas.ts）。任何一條路都回 true/false，永不回 NULL——CHECK 把 NULL 當通過。';

-- ---------------------------------------------------------------------------
-- 2. events 的七個清單欄位
-- ---------------------------------------------------------------------------
-- 順序就是前台由上到下的順序。唯一的一份名單在
-- src/lib/event-blocks.ts 的 EVENT_LIST_FIELDS，scripts/event-blocks-selftest.mjs
-- 會拿那一份逐欄回來比對這裡。
--
-- ⚠️ 是七個不是八個：快樂手那套「線上課程大綱／實體課程大綱」的二分對書店沒有
--    意義（一場講座就是一場講座），合併成單一 outline。也沒有「標籤」那一欄 ——
--    既有的 events.category（FK -> event_categories）就是。
--
-- default 是三個空陣列而不是 NULL：空清單的意思是「這一塊關掉」，是一個**明確的
-- 決定**；NULL 的意思是「不知道」，而前台對這兩件事要畫的東西一模一樣（什麼都不畫），
-- 於是那個區別只會製造 `?? []` 而不會製造任何價值。
alter table public.events
  add column if not exists highlights       jsonb not null default '{"zh": [], "en": [], "ja": []}'::jsonb,
  add column if not exists suitable_for     jsonb not null default '{"zh": [], "en": [], "ja": []}'::jsonb,
  add column if not exists not_suitable_for jsonb not null default '{"zh": [], "en": [], "ja": []}'::jsonb,
  add column if not exists takeaways        jsonb not null default '{"zh": [], "en": [], "ja": []}'::jsonb,
  add column if not exists outline          jsonb not null default '{"zh": [], "en": [], "ja": []}'::jsonb,
  add column if not exists includes         jsonb not null default '{"zh": [], "en": [], "ja": []}'::jsonb,
  add column if not exists notes            jsonb not null default '{"zh": [], "en": [], "ja": []}'::jsonb;

-- CHECK 逐欄加。`alter table … add constraint` 沒有 if not exists，所以照 0025 的
-- 寫法先問 pg_constraint —— 這一支要能重複套用。
--
-- ⚠️ 這七段刻意寫成七次而不是一個 foreach 迴圈。迴圈版本裡「哪一欄有 CHECK」這件事
--    只存在於一個陣列字面量裡，靜態自檢就只能數個數，數不出「第四欄漏了」。寫死七次
--    的代價是七倍的字，換到的是「每一欄的名字都在它自己的 CHECK 旁邊出現」。
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.events'::regclass
                    and conname  = 'events_highlights_localized_list') then
    alter table public.events add constraint events_highlights_localized_list
      check (public.is_localized_list(highlights));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.events'::regclass
                    and conname  = 'events_suitable_for_localized_list') then
    alter table public.events add constraint events_suitable_for_localized_list
      check (public.is_localized_list(suitable_for));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.events'::regclass
                    and conname  = 'events_not_suitable_for_localized_list') then
    alter table public.events add constraint events_not_suitable_for_localized_list
      check (public.is_localized_list(not_suitable_for));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.events'::regclass
                    and conname  = 'events_takeaways_localized_list') then
    alter table public.events add constraint events_takeaways_localized_list
      check (public.is_localized_list(takeaways));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.events'::regclass
                    and conname  = 'events_outline_localized_list') then
    alter table public.events add constraint events_outline_localized_list
      check (public.is_localized_list(outline));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.events'::regclass
                    and conname  = 'events_includes_localized_list') then
    alter table public.events add constraint events_includes_localized_list
      check (public.is_localized_list(includes));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.events'::regclass
                    and conname  = 'events_notes_localized_list') then
    alter table public.events add constraint events_notes_localized_list
      check (public.is_localized_list(notes));
  end if;
end $$;

comment on column public.events.highlights       is '活動亮點。jsonb {"zh":[…],"en":[…],"ja":[…]}，空陣列＝前台這一塊不畫。';
comment on column public.events.suitable_for     is '適合對象。同上。';
comment on column public.events.not_suitable_for is '不適合對象。刻意與 suitable_for 分開：「這場不適合誰」講清楚會減少現場的失望，而把它塞進適合對象裡用否定句寫，翻譯之後會變成兩種語氣。';
comment on column public.events.takeaways        is '帶得走什麼。同上。';
comment on column public.events.outline          is '流程大綱。合併了「線上／實體」的二分——一場講座就是一場講座。';
comment on column public.events.includes         is '費用包含什麼。⚠️ 這裡只寫「含一杯飲料」這種**內容**，金額的唯一真相在 products.price，不要在這裡寫數字。';
comment on column public.events.notes            is '注意事項。';

-- ---------------------------------------------------------------------------
-- 3. event_blocks —— 可重複的段落
-- ---------------------------------------------------------------------------
-- 🔴 **掛在 events.id 上，不掛 products。** 0004 的檔頭寫著「what the page says is a
--    different concern from what you can buy」，這一句在這裡有很實際的後果：一場活動
--    可以**先有內容、後有商品**（甚至永遠不賣票——免費場、外部報名場）。掛在
--    products 上等於規定「還沒開賣的活動不准寫 FAQ」。
--
-- 三種 kind，唯一的名單在 src/lib/event-blocks.ts 的 EVENT_BLOCK_KINDS，自檢會拿
-- 那一份與下面的 CHECK 逐字對帳。
--
--   · faq      —— 問／答。普世適用，而且 components/ui/accordion.tsx 已經在了。
--   · info_row —— 標籤／值。**最有價值的一種**：這個 schema 從 0001 起就沒有任何
--                 地址欄位，費用說明、交通、攜帶物品、退費規則全部靠它吸收。
--   · agenda   —— 時間／發生什麼。「19:30 入場、19:40 開場」是最常被問的一塊。
--
-- 🔴 **沒有 pricing。** event_sessions 刻意沒有 price 欄位（0020）；金額的唯一真相是
--    products.price。一個 pricing 段落會在前台印出**結帳不會收的金額** —— 那是第二個
--    金錢真相，而且沒有任何東西在維護它。
-- 🔴 **沒有 feature。** 它的形狀與 info_row 完全相同，差別只有 CSS 欄數。加一個只差
--    在版面的 kind，就是「五種 kind 沒人分得出來該用哪個」的起點。
--
-- 兩處刻意與參考來源不同：
--   · **沒有 meta jsonb。** 那一欄在來源那邊只為 pricing 存在，而且是三語化之後
--     唯一一個 CHECK 保護不到的地方（什麼形狀都能塞）。
--   · **title / body 都 not null。** nullable 會逼出「整列留白＝刪除」這種慣例，而那
--     條慣例在三語下會壞：把英文清空就整列消失，中文也一起不見了。要刪就 DELETE。
create table if not exists public.event_blocks (
  id         bigint primary key generated always as identity,
  event_id   text not null references public.events (id)
               on update cascade on delete cascade,
  kind       text not null,
  title      jsonb not null,
  body       jsonb not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_blocks_kind_valid check (kind in ('faq', 'info_row', 'agenda')),
  constraint event_blocks_title_localized check (public.is_localized(title)),
  constraint event_blocks_body_localized  check (public.is_localized(body)),
  constraint event_blocks_order_uniq unique (event_id, kind, sort_order)
);

comment on table public.event_blocks is
  '一場活動的可重複段落。一列＝畫面上的一列。kind 決定它長什麼樣（faq 問答／info_row 標籤值／agenda 時間事件），(event_id, kind) 內用 sort_order 排。掛在 events 不掛 products：活動可以先有內容再有商品。';
comment on column public.event_blocks.kind is
  '段落種類。與 src/lib/event-blocks.ts 的 EVENT_BLOCK_KINDS 逐字相等（自檢會對帳）。刻意只有三種，理由見本檔案 §3。';
comment on column public.event_blocks.title is
  'faq 的問題／info_row 的標籤／agenda 的時間。三語字串，not null——「留白當刪除」在三語下會壞。';
comment on column public.event_blocks.body is
  'faq 的答案／info_row 的值／agenda 的內容。三語字串，not null。';

create index if not exists event_blocks_event_idx
  on public.event_blocks (event_id, kind, sort_order);

drop trigger if exists event_blocks_set_updated_at on public.event_blocks;
create trigger event_blocks_set_updated_at
  before update on public.event_blocks
  for each row execute function public.set_updated_at();

-- RLS：與 0020 的 event_sessions 同一個形狀。
--
-- policy 裡的 exists(...) 是必要的第二半：沒有它，一場**草稿活動**的段落也會被前台
-- 讀到 —— 而活動的內容在公告之前就是不該被看到的東西。子查詢以**呼叫者的身分**
-- 執行，所以 anon 只查得到 is_published 的活動（0001 的 events_select_public），
-- 草稿自然 join 不到，fail-closed。
alter table public.event_blocks enable row level security;
revoke all   on table public.event_blocks from anon, authenticated;
grant select on table public.event_blocks to anon, authenticated;
grant all    on table public.event_blocks to service_role;

drop policy if exists event_blocks_select_public on public.event_blocks;
create policy event_blocks_select_public on public.event_blocks
  as permissive for select to anon, authenticated
  using (
    exists (
      select 1 from public.events e
       where e.id = event_blocks.event_id
         and e.is_published
    )
  );

drop policy if exists event_blocks_deny_insert on public.event_blocks;
create policy event_blocks_deny_insert on public.event_blocks
  as restrictive for insert to anon, authenticated with check (false);

drop policy if exists event_blocks_deny_update on public.event_blocks;
create policy event_blocks_deny_update on public.event_blocks
  as restrictive for update to anon, authenticated using (false) with check (false);

drop policy if exists event_blocks_deny_delete on public.event_blocks;
create policy event_blocks_deny_delete on public.event_blocks
  as restrictive for delete to anon, authenticated using (false);

-- ---------------------------------------------------------------------------
-- 4. admin_reorder_event_blocks() —— 重排
-- ---------------------------------------------------------------------------
-- 形狀逐字照 0002_admin.sql:103-151 的 admin_reorder_curated_items /
-- admin_reorder_page_list_items：先把要動的那幾列**停到負數**，再寫最終值。
--
-- 為什麼要停一次：event_blocks 有 unique (event_id, kind, sort_order)。一列一列改成
-- 最終位置，中途一定會撞上那個約束（交換兩列時無論先改哪一列都是 23505）。負數不會
-- 與任何真實值相撞，而 plpgsql 的函式本體是一個交易，所以那些負數對別人從來不存在。
--
-- ⚠️ **不要改成 client 驅動的四步重排**（讀 → 停 → 寫 → 再讀）。那種寫法的第 3 步
--    失敗時，資料會**留在停車位**上 —— 也就是使用者看到一個錯誤訊息，然後整份清單
--    的順序變成負數亂序，而且沒有任何東西會把它救回來。這裡整段在一個交易內，
--    失敗就是什麼都沒發生。
create or replace function public.admin_reorder_event_blocks(
  p_event_id text,
  p_kind     text,
  p_ids      bigint[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 停到負數（負值不可能與真實值相撞）。
  update event_blocks
     set sort_order = -sort_order - 1
   where event_id = p_event_id
     and kind = p_kind
     and id = any(p_ids);

  -- 寫最終位置：p_ids 內的 1-based 順位。
  update event_blocks eb
     set sort_order = pos.ord
    from unnest(p_ids) with ordinality as pos(id, ord)
   where eb.id = pos.id
     and eb.event_id = p_event_id
     and eb.kind = p_kind;
end;
$$;

comment on function public.admin_reorder_event_blocks(text, text, bigint[]) is
  '把一組段落重排成 p_ids 的順序。停到負數再寫最終值，整段在一個交易內——與 0002 的兩支 reorder 同一個形狀。SECURITY DEFINER，只有 service_role 叫得動。';

-- SECURITY DEFINER 代表它以 owner 的身分執行，所以絕對不可以被前台的 key 呼叫。
-- 只有 service_role（＝已經通過 requireAdmin() 的 server function）可以。
revoke execute on function public.admin_reorder_event_blocks(text, text, bigint[])
  from public, anon, authenticated;
grant  execute on function public.admin_reorder_event_blocks(text, text, bigint[])
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. admin_upsert_event_with_session() 開始吃這七個欄位
-- ---------------------------------------------------------------------------
-- 🔴 **create or replace，不 drop。** 這支函式吃的是**一個 payload jsonb**，簽名沒變
--    （0026 就是為了這一天才這樣設計的：加欄位不必改簽名，也就不會留下兩支同名
--    overload 讓 PostgREST 挑錯）。drop function 會連帶把 grant 一起丟掉。
--
-- ⚠️ payload 沒帶某一欄時**沿用資料庫裡的舊值**，不是蓋成空清單。理由與 0026 的
--    slug 同一條：前端漏送一個 key 不應該等於「使用者要求清空」。真的要清空就送
--    `{"zh":[],"en":[],"ja":[]}`——那是一個看得見的動作。

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
    highlights, suitable_for, not_suitable_for, takeaways, outline, includes, notes
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
    coalesce(v_ev -> 'notes',            v_prev.notes,            c_empty_list)
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
    notes             = excluded.notes
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
  '一個交易內建立／更新一場活動、它的商品與（選填的）一個場次，回傳三者。吃 jsonb 而不是具名參數，因為 create or replace function 不能改簽名——加欄位就會留下兩支同名 overload 讓 PostgREST 挑錯。products.description 取 events.summary（不是 events.description），這條規則只有這一個家。0027 起也吃 events 的七個三語清單欄位；payload 沒帶那個 key ＝那一欄不動。';

-- create or replace 會保留既有權限，這兩句是防守：萬一有人在別的地方 drop 過再建，
-- 這一支套完之後權限一定還是對的。
revoke execute on function public.admin_upsert_event_with_session(jsonb)
  from public, anon, authenticated;
grant  execute on function public.admin_upsert_event_with_session(jsonb)
  to service_role;

commit;
