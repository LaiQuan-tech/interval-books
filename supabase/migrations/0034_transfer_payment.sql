-- 0034_transfer_payment.sql — 匯款（銀行轉帳）付款方式
--
-- Requires 0005（orders / payments）、0006＋0011＋0020（expire_unpaid_orders）、
-- 0022（email_outbox / email_copy）、0032（site_settings 的 column-level grant）。
--
-- ## §0  在做什麼
--
-- 結帳頁本來只有兩個選項：「信用卡線上付款」（→ 黑貓 PAY，payment_method = 'card'）
-- 與「由我們與你聯繫付款」（payment_method = NULL）。店家要第三個：客人自己匯款到
-- 固定的公司帳戶，匯完回報末五碼，店家對帳之後手動標記已付款。
--
-- ## §0.1  🔴 為什麼這一支非動 expire_unpaid_orders() 不可
--
-- 正式庫上掛著一支每 5 分鐘的 pg_cron：
--
--     expire-unpaid-orders   */5 * * * *   select public.expire_unpaid_orders(interval '2 hours')
--
-- 它挑單的條件（0020:698-707，形狀從 0006 到現在沒變過）是
--
--     status = 'pending' and payment_status <> 'paid' and paid_at is null
--       and created_at < now() - p_older_than
--
-- ——**三個版本以來一次都沒有出現過 payment_method**。所以在不動它的情況下加匯款，
-- 結果是：客人下單、看到匯款帳號、隔天早上去銀行匯款，而訂單在**兩小時前**就已經
-- 被排程取消掉了——`event_registrations` 被刪、`event_sessions.seats_taken` 回沖、
-- 訂單 status = 'cancelled'。錢進來了，訂單不存在，位子給了別人，全程沒有任何錯誤
-- 訊息。這正是 0028 修的那個形狀（免費訂單掉單）的同一顆地雷，換一個引信。
--
-- 「位子保留三天」不需要新功能：座位是在**訂單成立當下**就預留的
-- （src/server/repos/orders.ts:110-117「Stock and seats are taken here, at order
-- time, before a single dollar has moved」；step 5 的 reserve_session_seat() 是
-- 無條件執行的，payment_method 只影響 step 7 要不要去金流）。要做的只有一件事：
-- **別讓過期排程提早把它收回去。**
--
-- ## §0.2  改法：只改本體那一個 WHERE，簽章與 RETURNS TABLE 逐字不動
--
-- `create or replace` **改不了 RETURNS TABLE 的形狀**（要改就得先 DROP FUNCTION，
-- 而 drop 會斷掉正在跑的 pg_cron job——0020 §9 的檔頭已經把這件事寫死成規約，
-- scripts/event-registration-selftest.mjs [5] 有一條在守它）。所以 §4 的函式定義是
-- 0020 那一份**逐字照抄**，唯一的差別是 claim 條件裡的那一行：
--
--     and o.created_at < now() - (case when o.payment_method = 'transfer'
--                                      then greatest(p_older_than, interval '3 days')
--                                      else p_older_than end)
--
-- 用 `greatest()` 而不是直接寫 `interval '3 days'` 是刻意的：日後有人手動用更長的
-- 區間清理（`select expire_unpaid_orders(interval '30 days')`），匯款訂單不應該因為
-- 這一行反而被**更早**收走。greatest 保證匯款單的門檻永遠 ≥ 其他單的門檻。
--
-- **cron 不用動。** 那支排程呼叫的是同一個函式名與同一組參數，換的是函式本體。
--
-- ## §0.3  為什麼是新的 'transfer'，不借用既有的 'atm'
--
-- `orders_payment_method_check` 現在的值域是
-- `NULL, 'card', 'atm', 'cvs_cod', 'test_paid', 'free'`（最新定義在 0028 §1）。
-- 'atm' 看起來很接近，但在這個 repo 裡它的語意是「金流商動態產生虛擬帳號、由金流商
-- 自動核帳」（src/server/blackcat.ts:772-798 的代收代付），而
-- src/lib/email-templates.ts:230 已經把它標成「ATM 轉帳」。固定帳號的人工匯款是另一
-- 件事：沒有虛擬帳號、沒有 webhook、對帳是人做的。兩個值合併之後就再也分不出「這張
-- 單在等金流回報」與「這張單在等店員看銀行對帳單」——而那兩者的處理方式完全不同。
--
-- 加值的做法照 0024 檔頭寫下、0028 §1 實際照做過一次的規矩：**drop + add，同一個
-- 交易**。中間那一瞬間 orders 沒有任何約束，併發寫入可以塞進任何字串，而 add
-- constraint 會因為那一列而失敗。
--
-- ## §0.4  ⚠️ site_settings 的四個銀行欄位**不進** anon 的 grant 清單
--
-- 0032 §0.2 把 site_settings 對 anon/authenticated 的 SELECT 從 table-level 收成
-- 逐欄授權。Postgres 的 column-level grant **不會自動涵蓋日後新增的欄位**，所以這一
-- 支只要 `add column` 而不碰 grant，四個銀行欄位天生就是 anon 讀不到的。
--
-- 這是刻意的，不是省事：匯款資訊由完成頁的 server function（service_role）讀出來，
-- 客人看到的是**他自己那一張訂單**的頁面，不是一個「任何人拿公開的 anon key 打
-- /rest/v1/site_settings?select=bank_account 就拿得到公司帳號」的端點。帳號本身不是
-- 秘密（信裡就寫著），但把它做成一個匿名可查的 API 端點沒有任何好處，而且會讓
-- 「這張表哪些欄位是公開的」這件事再次變成靠 src/lib/cms.ts 恰好沒 select 到它。
--
-- §1 結尾有一段 DO block 明著驗這件事：四欄只要有任何一欄對 anon 是可讀的就 raise，
-- migration 直接失敗。「沒 grant」是一個沉默的事實，沉默的事實需要一個會出聲的守衛。
--
-- ## §0.5  下單當下寄信——一條**全新的**觸發時機
--
-- 這個站到目前為止**沒有任何一封信是在下單當下寄的**。四封信（付款成功、報名成功、
-- 活動提醒、店家新訂單通知）全部只有一個入口 `queueOrderNotifications()`，而它的第一
-- 道閘門就是 `payment_status <> 'paid' → 'order_not_paid'`（0022 §8）。
--
-- 匯款信與「待聯繫付款」的店家通知信都必須在**錢還沒進來**的時候寄，所以它們不能走
-- 那條路，也**不可以**為了走那條路去放寬 claim_order_notify 的閘門——那道閘門守的是
-- 「沒收到錢不要告訴客人收到錢了」，是對的。
--
-- 新路徑掛在 src/server/repos/orders.ts 的 step 7 之後（訂單已經 durable）。冪等靠
-- 兩層：createOrder() 頂端本來就有 idempotency_key 的 replay 短路（orders.ts:803），
-- 而 email_outbox.dedupe_key 是 unique——與既有四封信同一個保證，不是新機制。
--
-- ## §0.6  dedupe_key 必須與 0032 那封分得開
--
-- 0032 的店家通知信是 `order_notify_admin:<order_id>`，在**付款成功之後**排。
-- 這一支新增的是 `order_placed_admin:<order_id>`，在**下單當下**排。
--
-- 🔴 兩者共用同一把 key 會有一個很難發現的後果：一張匯款訂單在下單當下佔掉了
--    `order_notify_admin:<id>`，店家對完帳把它標成已付款、
--    queueOrderNotifications() 跑起來時，那封「已收款」的通知信會撞 dedupe_key 變成
--    no-op——店家從此再也收不到任何一張匯款訂單的收款通知，而 outbox 裡看起來一切
--    正常（那一列確實存在，只是內容是三天前那封「有新單」）。
--    scripts/notify-selftest.mjs 有一條對真的 email_outbox 跑的斷言在守這件事。
--
-- ## §0.7  發票不用另外做
--
-- `invoice_backlog()`（0028 §3）的條件是 `payment_status = 'paid' and total > 0`，
-- **不看 payment_method**。所以匯款訂單被 §5 標成已付款之後，既有的每小時排程就會
-- 自動把它排進開票佇列。這一支一個字都不用碰發票。

begin;

-- ---------------------------------------------------------------------------
-- §1  site_settings —— 匯款帳戶（四欄）
-- ---------------------------------------------------------------------------
-- 形狀同 0032 的 notify_emails：一個值、後台可改、預設空字串代表「還沒設定」。
-- 空字串不是錯誤——沒設定的站台就是沒有匯款選項可以顯示的資料，前端自己決定要不要
-- 顯示（src/lib/checkout.ts 的 remittanceConfigured()）。
alter table public.site_settings
  add column if not exists bank_name         text not null default '',
  add column if not exists bank_code         text not null default '',
  add column if not exists bank_account      text not null default '',
  add column if not exists bank_account_name text not null default '';

comment on column public.site_settings.bank_name is
  '匯款銀行名稱，例如「中國信託銀行」。⚠️ 見 0034 §0.4：anon/authenticated 讀不到這一欄，完成頁走 server function（service_role）讀。';
comment on column public.site_settings.bank_code is
  '銀行代號（三碼），例如「822」。⚠️ 同 bank_name：不在 anon 的 column-level grant 清單裡。';
comment on column public.site_settings.bank_account is
  '匯款帳號。⚠️ 同 bank_name：不在 anon 的 column-level grant 清單裡。';
comment on column public.site_settings.bank_account_name is
  '匯款戶名，例如「好日子股份有限公司」。⚠️ 同 bank_name：不在 anon 的 column-level grant 清單裡。';

-- §0.4 的守衛。column-level grant 不涵蓋新欄位是 Postgres 的行為，不是這支
-- migration 做的事——所以要有東西明著確認它真的成立，而不是假設它成立。
-- 反面對照也在這裡：既有的公開欄位（short_desc）必須仍然讀得到，否則
-- 「四欄讀不到」有可能是因為整張表的 grant 被誰不小心收光了，那是另一個 bug。
do $$
declare
  col text;
begin
  foreach col in array array['bank_name', 'bank_code', 'bank_account', 'bank_account_name']
  loop
    if has_column_privilege('anon', 'public.site_settings', col, 'SELECT') then
      raise exception
        'anon 讀得到 site_settings.% —— 0034 §0.4 說它不該讀得到。有人把 table-level grant 加回去了嗎？', col;
    end if;
    if has_column_privilege('authenticated', 'public.site_settings', col, 'SELECT') then
      raise exception
        'authenticated 讀得到 site_settings.% —— 見 0034 §0.4。', col;
    end if;
  end loop;

  -- 反空殼：確認上面那四條不是因為整張表都讀不到才通過的。
  if not has_column_privilege('anon', 'public.site_settings', 'short_desc', 'SELECT') then
    raise exception
      'anon 連 site_settings.short_desc 都讀不到 —— 0032 §0.2 的公開欄位清單被收掉了，前台會 42501。';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- §2  orders —— 認得 'transfer'，並記下客人回報的末五碼
-- ---------------------------------------------------------------------------
-- §0.3：drop + add 在同一個交易裡。既有六個值原樣保留。
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method is null
         or payment_method in ('card', 'atm', 'cvs_cod', 'test_paid', 'free', 'transfer'));

comment on column public.orders.payment_method is
  '這張訂單怎麼結清的。NULL ＝ 沒有經過金流、由店家另行安排付款（還有錢要收）；''transfer'' ＝ 客人匯款到店家的固定帳戶，人工對帳（0034），與 ''atm''（金流商動態虛擬帳號、自動核帳）是兩件事；''free'' ＝ total = 0，沒有錢要收（0028）；''test_paid'' ＝ 沙盒。不要合併。';

alter table public.orders
  add column if not exists remittance_last5        text,
  add column if not exists remittance_reported_at  timestamptz;

-- 格式在資料庫這一層也擋一次。應用層（src/lib/checkout.ts 的 zod）已經擋過，但
-- 這一欄是客人直接輸入的自由文字，而它會被印在後台的對帳畫面上——兩層都擋的成本
-- 是一行 CHECK，而少一層的代價是「有人在末五碼欄位裡塞了一段 HTML」。
alter table public.orders drop constraint if exists orders_remittance_last5_check;
alter table public.orders add constraint orders_remittance_last5_check
  check (remittance_last5 is null or remittance_last5 ~ '^[0-9]{5}$');

-- 兩欄要嘛都是 null，要嘛都有值。半套的狀態（有末五碼沒時間、有時間沒末五碼）在
-- 後台畫面上長得跟「還沒回報」一樣，是靜默的。
alter table public.orders drop constraint if exists orders_remittance_pair_check;
alter table public.orders add constraint orders_remittance_pair_check
  check ((remittance_last5 is null) = (remittance_reported_at is null));

comment on column public.orders.remittance_last5 is
  '客人回報的匯款帳號末五碼（0034）。只能回報一次——寫入是一句帶 `remittance_last5 is null` 的條件式 UPDATE（src/server/repos/orders.ts 的 reportRemittance()），不是可以反覆塗改的欄位。';
comment on column public.orders.remittance_reported_at is
  '客人回報末五碼的時間（0034）。與 remittance_last5 由 CHECK 綁成同進同出。';

create index if not exists orders_remittance_pending_idx
  on public.orders (created_at)
  where payment_method = 'transfer' and payment_status <> 'paid';

comment on index public.orders_remittance_pending_idx is
  '後台「待對帳的匯款訂單」清單用（0034）。partial index——待對帳的單永遠是全表的極小子集。';

-- ---------------------------------------------------------------------------
-- §3  email_copy 認得 'remittance'
-- ---------------------------------------------------------------------------
-- 0022 §2 的 CHECK 只允許四個 template_key。加值的規矩同 §0.3：drop + add，同一個
-- 交易，既有四個原樣保留。
alter table public.email_copy drop constraint if exists email_copy_template_valid;
alter table public.email_copy add constraint email_copy_template_valid
  check (template_key in ('common', 'order_paid', 'registration_ticket', 'session_reminder', 'remittance'));

-- ⚠️ scripts/notify-selftest.mjs 有一條「反空殼」比對：src/lib/email-templates.ts 的
--    DEFAULT_EMAIL_COPY 的每一把 key 都必須在 migration 的 seed 裡對得到，一把不多
--    一把不少。它原本只讀 0022 那一段 insert，所以新 key 種在這裡會讓它直接紅——
--    這一期把那條比對改成**掃所有種 email_copy 的 migration**（0022 ∪ 0034），
--    而不是放寬它。放寬它等於把這個 repo 的反空殼守衛拆掉。
--
-- on conflict do nothing：重跑 migration 不會蓋掉 user 之後填的正式文案。
insert into public.email_copy (template_key, string_key, value, sort_order) values
  ('remittance', 'subject',
   '{"zh":"（待補：匯款資訊信主旨）訂單 {orderNo} 的匯款資訊","en":"（待補：匯款資訊信主旨）Bank transfer details for order {orderNo}","ja":"（待補：匯款資訊信主旨）ご注文 {orderNo} のお振込のご案内"}'::jsonb, 10),
  ('remittance', 'heading',
   '{"zh":"（待補：匯款資訊信標題）訂單已成立，請於期限前完成匯款","en":"（待補：匯款資訊信標題）Your order is placed — please transfer by the due date","ja":"（待補：匯款資訊信標題）ご注文を承りました。期日までにお振込ください"}'::jsonb, 20),
  ('remittance', 'intro',
   '{"zh":"（待補：匯款資訊信開頭段落）","en":"（待補：匯款資訊信開頭段落）","ja":"（待補：匯款資訊信開頭段落）"}'::jsonb, 30),
  ('remittance', 'outro',
   '{"zh":"（待補：匯款資訊信結尾段落，例如「匯款後請回訂單頁填寫帳號末五碼，我們核對後會再通知你」）","en":"（待補：匯款資訊信結尾段落）","ja":"（待補：匯款資訊信結尾段落）"}'::jsonb, 40)
on conflict (template_key, string_key) do nothing;

-- ---------------------------------------------------------------------------
-- §4  expire_unpaid_orders —— 匯款訂單至少留 3 天
-- ---------------------------------------------------------------------------
-- 🔴 見 §0.1／§0.2。這是這一支唯一有可能弄壞既有行為的地方，所以規矩最嚴：
--
--   · 下面這一份是 0020:670-840 的**逐字照抄**，唯一的差別是第 1 步 claim 條件裡
--     的 `and o.created_at < …` 那一行（原本是 `now() - p_older_than`）。
--   · **簽章與 RETURNS TABLE 一個字都不准動。** create or replace 改不了 RETURNS
--     TABLE 的形狀，而 drop function 會斷掉正式庫上那支每 5 分鐘的 pg_cron
--     （0020 §9、0023）。scripts/event-registration-selftest.mjs [5] 現在把 0011 /
--     0020 / 0034 三份的 returns table 區塊拿去互相比對。
--   · **cron 不用動**：它呼叫的是 `select public.expire_unpaid_orders(interval '2 hours')`，
--     同一個函式名、同一組參數，換的只是函式本體。
--
-- 為什麼是 3 天：客人在銀行的營業時間才匯得了款，週五晚上下的單最快也要下週一才
-- 匯得到。2 天會讓「週五下單、週一匯款」剛好落在門外。這個數字寫死在函式裡而不是
-- 做成設定，理由與 0022 的 REMINDER_LEAD 相同：它是一條與資料庫排程綁在一起的
-- 業務規則，做成可設定就多一個「設成 0 分鐘之後全部訂單當場蒸發」的入口。

create or replace function public.expire_unpaid_orders(
  p_older_than interval default '30 minutes',
  p_limit      integer  default 200
)
returns table (
  expired_id       uuid,
  expired_order_no text,
  restored_stock   integer,
  restored_seats   integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  if p_limit is null or p_limit <= 0 then
    raise exception 'INVALID_LIMIT:%', p_limit;
  end if;
  if p_older_than is null or p_older_than < interval '0' then
    raise exception 'INVALID_INTERVAL:%', p_older_than;
  end if;

  -- ---- 1. claim the candidates ------------------------------------------
  select array_agg(c.id)
    into v_ids
    from (
      select o.id
        from public.orders o
       where o.status = 'pending'
         and o.payment_status <> 'paid'
         and o.paid_at is null
         -- 🔴 0034 唯一改動：匯款訂單至少留 3 天。整支函式其餘部分逐字照抄 0020。
         and o.created_at < now() - (case when o.payment_method = 'transfer'
                                          then greatest(p_older_than, interval '3 days')
                                          else p_older_than end)
       order by o.created_at
       limit p_limit
         for update skip locked
    ) c;

  if v_ids is null or cardinality(v_ids) = 0 then
    return;
  end if;

  -- ---- 2. lock the products, in id order --------------------------------
  perform 1
    from public.products p
   where p.id in (
           select oi.product_id
             from public.order_items oi
            where oi.order_id = any(v_ids)
              and oi.product_id is not null
         )
   order by p.id
     for update;

  -- ---- 3. give the goods back -------------------------------------------
  update public.products p
     set stock = p.stock + agg.qty
    from (
      select oi.product_id as pid, sum(oi.quantity)::integer as qty
        from public.order_items oi
       where oi.order_id = any(v_ids)
         and oi.product_id is not null
         and oi.product_type in ('goods', 'book')
       group by oi.product_id
    ) agg
   where p.id = agg.pid
     and p.stock is not null;

  -- ---- 4. give the seats back -------------------------------------------
  -- 0020 之後這一句是必然的 no-op（products.seats_taken 被 CHECK 綁成 0），
  -- 逐字保留 —— 見本節開頭。真正還名額的是 4c。
  update public.products p
     set seats_taken = greatest(0, p.seats_taken - agg.qty)
    from (
      select oi.product_id as pid, sum(oi.quantity)::integer as qty
        from public.order_items oi
       where oi.order_id = any(v_ids)
         and oi.product_id is not null
         and oi.product_type in ('event', 'journey')
       group by oi.product_id
    ) agg
   where p.id = agg.pid;

  -- ---- 4b. 放掉進銷存的保留（0011 新增）---------------------------------
  perform 1
    from inv.products ip
   where ip.id in (
           select r.inv_product_id
             from public.stock_reservations r
            where r.order_id = any(v_ids)
         )
   order by ip.id
     for update;

  delete from public.stock_reservations r
   where r.order_id = any(v_ids);

  -- ---- 4c. 放掉場次名額與參加者（0020 新增）-----------------------------
  -- 刪 registrations 與扣 seats_taken 在同一句裡（data-modifying CTE），所以
  -- 不存在「人刪掉了、位子還算著」的中間狀態 —— 與 reserve 是同一句的道理相同。
  --
  -- 鎖順序 public.products → inv.products → event_sessions，見 §4。
  perform 1
    from public.event_sessions s
   where s.id in (
           select r.session_id
             from public.event_registrations r
            where r.order_id = any(v_ids)
         )
   order by s.id
     for no key update;

  with freed as (
    delete from public.event_registrations r
     where r.order_id = any(v_ids)
    returning r.session_id
  ), agg as (
    select session_id, count(*)::integer as n from freed group by session_id
  )
  update public.event_sessions s
     set seats_taken = greatest(0, s.seats_taken - agg.n)
    from agg
   where s.id = agg.session_id;

  -- ---- 5. cancel the orders ---------------------------------------------
  update public.orders o
     set status         = 'cancelled',
         payment_status = case
                            when o.payment_status = 'pending' then 'failed'
                            else o.payment_status
                          end,
         cancelled_at   = now(),
         failed_reason  = 'unpaid_timeout'
   where o.id = any(v_ids)
     and o.status = 'pending'
     and o.payment_status <> 'paid'
     and o.paid_at is null;

  -- ---- 6. close out the payment attempts ---------------------------------
  update public.payments pay
     set status = 'failed'
   where pay.order_id = any(v_ids)
     and pay.status = 'pending';

  -- ---- 7. report what happened -------------------------------------------
  return query
    select o.id,
           o.order_no,
           coalesce((
             select sum(oi.quantity)::integer
               from public.order_items oi
               join public.products pr on pr.id = oi.product_id
              where oi.order_id = o.id
                and oi.product_type in ('goods', 'book')
                and pr.stock is not null
           ), 0),
           coalesce((
             select sum(oi.quantity)::integer
               from public.order_items oi
               join public.products pr on pr.id = oi.product_id
              where oi.order_id = o.id
                and oi.product_type in ('event', 'journey')
           ), 0)
      from public.orders o
     where o.id = any(v_ids)
       and o.status = 'cancelled'
     order by o.order_no;
end;
$$;


comment on function public.expire_unpaid_orders(interval, integer) is
  '未付款超過 p_older_than 的訂單：還庫存、還場次名額、刪參加者、取消訂單、關掉未完成的付款嘗試。0034 起匯款訂單（payment_method = ''transfer''）的門檻改成 greatest(p_older_than, 3 days) —— 人去銀行匯款需要時間，而座位在下單當下就已經預留（見 0034 §0.1）。RETURNS TABLE 的形狀自 0006 起逐字未變。';

-- create or replace 保留既有的 grant，但照 0011／0020 的做法再宣告一次 —— 讓
-- 「這支函式只有 service_role 叫得動」這件事在每一支重寫它的 migration 裡都看得到，
-- 而不是靠讀者去翻 0006。
revoke execute on function public.expire_unpaid_orders(interval, integer) from public;
revoke execute on function public.expire_unpaid_orders(interval, integer) from anon, authenticated;
grant  execute on function public.expire_unpaid_orders(interval, integer) to service_role;

-- ---------------------------------------------------------------------------
-- §5  admin_mark_order_paid —— 店家對完帳，手動把匯款訂單標成已付款
-- ---------------------------------------------------------------------------
--
-- ⚠️ **不要重用 src/server/repos/payments.ts 的 markOrderPaid()。** 那一支會把
--    payment_method 硬寫成 'card'（payments.ts:301）——它只服務金流 webhook，那條
--    路上的訂單本來就是刷卡的。拿它來標記匯款訂單，會讓一張匯款單在資料庫裡變成
--    刷卡單：後台的付款方式欄從此說謊、對帳報表把它算進刷卡手續費、而且
--    remittance_last5 旁邊寫著「信用卡」。所以這裡是一支新函式，而它的重點正是
--    **保留原本的 payment_method**。
--
-- 狀態組合與 markOrderPaid() / settle_free_order() 逐字相同（status = 'processing'、
-- payment_status = 'paid'、paid_at = now()），只有 payment_method 不動——三條路推到
-- 的是同一個終局狀態，這一點不可以分岔，否則 invoice_backlog()、簽到表
-- （admin_event_roster 的 on_roster）與 claim_order_notify() 這三個「看訂單狀態」的
-- 地方會對匯款訂單有不同的答案。
--
-- 閘門形狀抄 0028 §2 的 settle_free_order()：先對訂單列 `for update`（用訂單列本身
-- 當序列化點），再逐條回一個具名的 reason，讓呼叫端分得出「我做的」「已經是那樣了」
-- 「這張單不該走這條路」。
--
-- ⚠️ **金額從資料庫那一列讀，不從參數讀。** 同 settle_free_order 的理由：這是一支
--    security definer、能把訂單標成已付款的函式，一個 p_amount 參數就等於一個
--    「幫我把這張三千塊的單標成付清」的入口。p_note 是給人看的備註（"對到 9/2
--    23:15 那筆"），不參與任何判斷。
--
-- p_actor_id / p_note 落進 public.payments 那一列的 raw_response：那張表本來就是
-- 「這張訂單的付款嘗試」的稽核紀錄，手動核銷是其中一種嘗試。gateway = 'transfer'
-- 把它與金流商的列分得開；gateway_tx_id = order_no 讓 payments_gateway_tx_idx
-- （unique on (gateway, gateway_tx_id)）順手保證同一張單不會留下兩列稽核。
create or replace function public.admin_mark_order_paid(
  p_order_id uuid,
  p_actor_id uuid,
  p_note     text
)
returns table (
  marked   boolean,
  reason   text,
  order_no text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  if p_order_id is null then
    raise exception 'NULL_ORDER_ID';
  end if;

  -- ---- 閘門 1：訂單列鎖 ---------------------------------------------------
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    return query select false, 'order_not_found', null::text;
    return;
  end if;

  -- 已經收過錢了 —— 冪等成功（店家連點兩下、兩個人同時按）。
  if v_order.payment_status = 'paid' then
    return query select false, 'already_paid', v_order.order_no;
    return;
  end if;

  -- 取消掉的、失敗的、已經在出貨的，都不准被推回 paid。
  if v_order.status <> 'pending' then
    return query select false, 'order_not_pending', v_order.order_no;
    return;
  end if;

  -- ---- 寫入 --------------------------------------------------------------
  -- 述詞在列已經被鎖住的情況下重述一次（同 0006 步驟 5、0028 §2 的理由）：不花成本，
  -- 而且日後有人改上面的判斷式時，這一句不會悄悄變成「不管三七二十一標成付清」。
  --
  -- ⚠️ **payment_method 不在 SET 清單裡。** 這是這支函式存在的理由，見本節開頭。
  update public.orders o
     set status         = 'processing',
         payment_status = 'paid',
         paid_at        = now()
   where o.id = p_order_id
     and o.status = 'pending'
     and o.payment_status <> 'paid';

  if not found then
    return query select false, 'order_not_pending', v_order.order_no;
    return;
  end if;

  -- 稽核列。best-effort：它失敗不該讓「錢已經收到了」這件事回滾——但它在同一個
  -- 交易裡，所以用 on conflict do nothing 而不是吞例外（吞例外會讓整個交易進入
  -- aborted 狀態，接下來每一句都會失敗）。
  insert into public.payments (order_id, gateway, gateway_tx_id, status, amount, paid_at, raw_response)
  values (
    p_order_id, 'transfer', v_order.order_no, 'paid', v_order.total, now(),
    jsonb_build_object(
      'source',            'admin_mark_order_paid',
      'actor_id',          p_actor_id,
      'note',              coalesce(p_note, ''),
      'remittance_last5',  v_order.remittance_last5,
      'payment_method',    v_order.payment_method
    )
  )
  on conflict (gateway, gateway_tx_id) where gateway_tx_id is not null do nothing;

  return query select true, 'marked', v_order.order_no;
end;
$$;

comment on function public.admin_mark_order_paid(uuid, uuid, text) is
  '店家對完銀行帳之後手動把一張訂單標成已付款（0034）。狀態組合與 markOrderPaid() 相同，但**保留原本的 payment_method** —— 那一支會把它硬寫成 ''card''，用在匯款訂單上會讓資料庫從此說謊。金額只從訂單那一列讀，呼叫端無法宣稱收到多少。冪等：第二次回 already_paid。';

-- SECURITY DEFINER，而且它能把訂單標成已付款 —— 絕不能讓瀏覽器的金鑰碰得到。
-- 處理方式同 0028 §2 / 0032 §3：execute 預設就 grant 給 public，所以「從 public
-- revoke」才是真正生效的那一半，anon/authenticated 是保險（public schema 的函式會
-- 被 PostgREST 當成 RPC 端點暴露出去）。
revoke execute on function public.admin_mark_order_paid(uuid, uuid, text) from public;
revoke execute on function public.admin_mark_order_paid(uuid, uuid, text) from anon, authenticated;
grant  execute on function public.admin_mark_order_paid(uuid, uuid, text) to service_role;

commit;
