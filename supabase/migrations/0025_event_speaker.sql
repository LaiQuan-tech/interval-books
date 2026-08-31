-- 0025_event_speaker.sql —— 活動掛上講者：public.events.speaker_id → public.artists.id
--
-- 前一支是 0024_blackcat_payment.sql。既有 0001–0024 一律不動（規約：已套用的
-- migration 永不修改），所以要加的東西都用這一支新的來加。
--
-- 依賴的兩張表都比 0024 早：public.events 在 0001_init.sql:175，public.artists 在
-- 0019_vendors_pii_portal.sql:2146。所以這一支與 0024 之間沒有相依關係，照檔名
-- 順序套用即可。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 為什麼是「一場活動一位講者」，而不是 join 表
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 這是刻意的決定，不是先做簡單版之後再說。
--
-- 一場書店講座的真實基數就是**一位主講**。做成 event_speakers join 表的話，
-- 為了服務一個現在不存在的基數，要連帶養出一整組東西：
--
--   · 一支 reorder 函式（誰排第一位？「主講」與「與談」怎麼分？）
--   · 一組 RLS policy 與 grant（多一張表就多一個授權面）
--   · 後台一塊「加一列／刪一列／拖曳排序」的 UI
--   · 前台一段「一位時長這樣、兩位時長那樣」的排版分支
--
-- 這四樣現在沒有任何一樣有需求撐著。而真的出現對談場（兩位以上）時，補救是
-- **加法**不是重寫：新開一支 migration 建 join 表，把現有 speaker_id 當成
-- 「role='host', position=0」那一列灌進去，然後把 speaker_id 留著或砍掉。
-- 那是一次資料搬遷，不是一次架構翻修。
--
-- 反過來說，先做 join 表卻只用到一列，付出的成本從第一天就開始收，而且不會退。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 為什麼是 on delete set null，而不是 cascade
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 講者是活動的**屬性**，不是活動的**所有者**。
--
-- cascade 的語意是「這一列不存在的話，那些列也不該存在」。用在這裡就是：
-- 店家在講者後台按下刪除，一場已經辦過、有報名紀錄、有訂單、有發票的講座
-- 會**跟著消失**。那不是資料庫在維護一致性，那是資料庫在幫忙湮滅證據。
--
-- 何況 public.event_registrations（0020）與 public.orders（0005）都掛在活動下面，
-- 一路 cascade 下去會連報名名單一起帶走。
--
-- set null 的語意才是對的：講者資料被刪掉了，活動還在，只是不知道誰講的。
-- 前台那一塊「講者介紹」就不顯示 —— 少一塊區塊，不是少一場活動。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ 部署順序：這一支必須**先**套上 live DB，才能推含有新欄位的程式碼
-- ═══════════════════════════════════════════════════════════════════════════
--
-- src/server/repos/events.ts 的 COLUMNS 常數會 select speaker_id。欄位還不存在時
-- PostgREST 直接回 400/500，而那是 /admin/events 的 loader —— 也就是整個活動後台
-- 打不開，不是少一個欄位而已。
--
-- 公開站那一側**不受影響**：src/lib/cms.ts#fetchEvents() 的欄位清單是自己寫死的
-- 一串，沒有 speaker_id，所以先推程式碼也不會讓前台壞掉。會壞的只有後台。
--
-- **先套 migration，再推程式碼。**
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 冪等
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 整支可以重複執行。欄位用 add column if not exists；外鍵**不**寫在 add column
-- 裡面，而是拆成獨立的 do $$ 加上 pg_constraint 查詢 —— 因為
-- `add column if not exists x text references …` 在欄位已存在時會把整段跳過，
-- 包含那個 references。萬一上一次只跑到一半（欄位建了、約束沒建），下一次重跑
-- 會安靜地維持那個殘缺狀態。拆開就沒有這個中間狀態。

begin;

-- ── 欄位 ──────────────────────────────────────────────────────────────────
-- text 而不是 uuid：public.artists.id 是 `text primary key`（0019:2147），
-- 型別必須對得上才建得起外鍵。
alter table public.events
  add column if not exists speaker_id text;

-- ── 外鍵（set null，理由見檔頭） ──────────────────────────────────────────
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.events'::regclass
       and conname  = 'events_speaker_id_fkey'
  ) then
    alter table public.events
      add constraint events_speaker_id_fkey
      foreign key (speaker_id)
      references public.artists (id)
      on delete set null;
  end if;
end $$;

-- ── 索引 ──────────────────────────────────────────────────────────────────
-- 兩個用途，都不是「查得比較快」這種模糊的理由：
--
--   1. **刪講者那一刻**。on delete set null 的 RI trigger 會在 events 上跑
--      `where speaker_id = $1`。沒有索引就是一次全表掃描 —— 而且是在持有鎖的
--      交易裡面。
--   2. 「這位講者講過哪幾場」是講者後台與未來活動頁都會問的問題。
--
-- 用 partial index 是因為大多數活動沒有講者（讀書會、市集、既有的全部活動），
-- 那些列進索引只是浪費。`speaker_id = $1` 蘊含 `speaker_id is not null`，
-- planner 證得出來，所以 RI trigger 一樣用得到這個索引。
-- 同樣手法見 0001_init.sql:205 的 events_published_idx。
create index if not exists events_speaker_idx
  on public.events (speaker_id)
  where speaker_id is not null;

-- ── 註解 ──────────────────────────────────────────────────────────────────
comment on column public.events.speaker_id is
  '主講人，FK -> public.artists(id)，on delete set null。NULL 代表這場沒有指定講者（讀書會、市集、既有活動一律是 NULL）。刻意是單一欄位而不是 join 表：一場書店講座的真實基數就是一位主講，真的出現對談再開新 migration 建 join 表把這一欄灌進去，那是加法不是重寫。';

-- events 的 RLS 與 grant 在 0001_init.sql:559-575 已經設好，而且是**表層級**的
-- `grant select on table public.events to anon, authenticated`（不是欄位層級），
-- 所以新欄位自動被涵蓋，這裡不需要、也不應該再動一次授權。

commit;

-- 驗證（套用後請跑）：
--   -- 欄位在不在：
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_schema='public' and table_name='events' and column_name='speaker_id';
--
--   -- 外鍵的刪除行為必須是 'n'（SET NULL）。'c' 是 CASCADE —— 看到 c 就是錯的：
--   select conname, confdeltype from pg_constraint
--    where conrelid='public.events'::regclass and conname='events_speaker_id_fkey';
--
--   -- 索引在不在：
--   select indexname from pg_indexes
--    where schemaname='public' and tablename='events' and indexname='events_speaker_idx';
