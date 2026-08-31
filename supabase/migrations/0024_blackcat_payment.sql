-- 0024_blackcat_payment.sql —— 黑貓 PAY（統一客樂得 COCS）線上刷卡上線所需的欄位
--
-- 前一支是 0023_fix_cron_guard.sql。既有 0001–0023 一律不動（規約：已套用的
-- migration 永不修改），所以要加的東西都用這一支新的來加。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 為什麼這一支這麼小 —— 0005 早就把「多金流」設計進去了
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 這一期把實際在跑的刷卡路線從 PayUni 直連 UPP 換成黑貓 PAY（COCS）。直覺上
-- 會以為要建一整組新表，實際上**一張新表都不用建**，因為 0005 的三個決定
-- 已經預先處理掉了：
--
--   1. public.webhook_events 的鍵是 `unique (gateway, event_key)`，不是
--      `unique (event_key)`。0005 §265-270 的註解寫得很清楚，那是刻意的：
--      「goodday 只用 CAS 守 pending→paid，第二種 webhook 一出現就什麼都守不住」。
--      所以黑貓的 APN 直接沿用同一張表，去重鎖天生不會跟 PayUni 打架。
--
--   2. public.payments.gateway 是 `text not null default 'payuni'`，**沒有
--      CHECK 約束**。寫入 'blackcat' 不需要先 drop constraint。
--
--   3. 唯一索引 payments_gateway_tx_idx 是 `(gateway, gateway_tx_id)`。同一個
--      order_no 在兩個 gateway 底下是**兩列**，「一個訂單一個金流一筆交易」
--      仍然是資料庫層級的事實，而不是慣例。
--
-- 所以剩下真正要加的只有兩個欄位與一支對帳函式。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ 部署順序：這一支必須**先**套上 live DB，才能推含有新欄位的程式碼
-- ═══════════════════════════════════════════════════════════════════════════
--
-- src/server/repos/payments.ts 的 updatePaymentRow() 會寫 payments.gateway_trans_id。
-- 欄位還不存在時 PostgREST 會回錯誤。
--
-- 這一次的後果是「稽核列沒更新」而不是「付款掉了」—— 因為那一句是在
-- markOrderPaid() 的 CAS **成功之後**才跑，而且 updatePaymentRow() 只 log 不 throw，
-- 訂單早就已經是 paid 了。但那仍然是一行紅色的 log 和一列對不上的帳，
-- 沒有理由用這個順序上線。**先套 migration，再推程式碼。**
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 這一支**不動** orders.payment_method 的 CHECK，理由與日後真的要動時的作法
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 目前是（0005 §88-89）：
--     check (payment_method is null or payment_method in ('card','atm','cvs_cod','test_paid'))
--
-- 這一輪只做**線上刷卡**，值就是 'card'，已經在裡面了。
--
-- 下一期要接黑貓的代收代付（ibon / ATM 虛擬帳號 / 三段條碼）時，先確認一件事：
-- ibon 超商繳款對得上既有的 'cvs_cod'、ATM 虛擬帳號對得上既有的 'atm'，
-- **兩個都已經在清單裡** —— 所以多半根本不需要動這條 CHECK。
--
-- 真的需要新值（例如要把黑貓的 ibon 和 ECPay 的超商取貨付款分開統計）時，
-- 規矩是新開一支 migration（0025 或更後面），用 drop + add，這一支不改：
--
--     alter table public.orders drop constraint orders_payment_method_check;
--     alter table public.orders add  constraint orders_payment_method_check
--       check (payment_method is null or payment_method in
--              ('card','atm','cvs_cod','test_paid','blackcat_ibon','blackcat_atm'));
--
-- ⚠️ drop 與 add 必須在**同一個交易**裡，否則中間那一瞬間 orders 沒有任何約束，
--    併發的寫入可以塞進任何字串進來，而 add constraint 會因為那一列而失敗。

begin;

-- ---------------------------------------------------------------------------
-- §1 orders.payment_url —— 黑貓回來的刷卡網址
-- ---------------------------------------------------------------------------
-- 兩個金流交出來的東西形狀不同，這是整個串接最容易被抹平的差異：
--
--   PayUni UPP    交易在**瀏覽器 POST 表單**的那一刻才產生。伺服器端沒有任何
--                 東西可以存 —— 沒有網址、沒有交易編號。
--   黑貓 COCS     伺服器端呼叫 CocsOrderAppend 就把訂單建出來了，回來一個
--                 可以直接導過去的付款網址（規格 V1.28.2 P42 的 `url` 欄位）。
--
-- 存下來有兩個用途：客人關掉分頁之後「重新付款」不必再跟黑貓建一次單，
-- 以及後台看得到「這張訂單當初被送去哪裡」。PayUni 那條路這一欄永遠是 null，
-- 那不是遺漏，是它本來就沒有這個東西。
alter table public.orders add column if not exists payment_url text;

comment on column public.orders.payment_url is
  '黑貓 PAY (COCS) 建單回覆的線上刷卡網址。PayUni 走表單 POST，沒有網址，該路線永遠為 null。含金流商產生的一次性 token，絕不可外流給非本人。';

-- ---------------------------------------------------------------------------
-- §2 payments.gateway_trans_id —— 金流商那一側的交易識別碼
-- ---------------------------------------------------------------------------
-- gateway_tx_id 存的是**我們的** order_no（送出去當 cust_order_no / MerTradeNo）。
-- 這一欄存的是**對方的**識別碼：黑貓 APN 的 trans_id（規格 P87，32 碼，每筆線上
-- 刷卡訂單唯一）。對帳時要拿它去黑貓後台查，沒有它只能靠時間和金額猜。
alter table public.payments add column if not exists gateway_trans_id text;

comment on column public.payments.gateway_trans_id is
  '金流商那一側的交易識別碼（黑貓 APN 的 trans_id / PayUni 的 TradeNo）。與 gateway_tx_id（我們自己的 order_no）是不同的東西，對帳時兩個都要。';

-- 對帳查詢用。可為 null（建單當下還不知道），所以是 partial index。
create index if not exists payments_gateway_trans_idx
  on public.payments (gateway, gateway_trans_id)
  where gateway_trans_id is not null;

-- ---------------------------------------------------------------------------
-- §3 public.payment_alerts() —— 把「收到通知但拒絕標記付款」的事件撈出來
-- ---------------------------------------------------------------------------
-- webhook handler 有四層防護，前三層擋掉的東西都是「不該發生、發生了要有人看」：
--
--   amount_mismatch     實收金額與 orders.total 不符
--   missing_pay_amount  黑貓說授權成功，但通知裡讀不到 payment_detail.pay_amount
--                       ⚠️ 這一條是這次串接最重要的拒絕理由。規格 P35 注意事項 2
--                          紅字要求「以實際繳款金額判別應實收是否相符後才撥付商品」，
--                          而 amount 欄位是繳款單金額、不是實收。讀不到 pay_amount
--                          時**唯一正確的行為是拒絕**，不是退而求其次拿別的欄位
--                          充數 —— 那會讓比對變成恆真。
--   order_not_found     通知指向一張我們沒有的訂單
--   paid_after_cancel   錢收了但訂單已被 0006 的排程取消，庫存可能已經還回去
--
-- 這些全部只留在 webhook_events.payload 裡，沒有人會主動去翻。這支函式是給
-- 後台與人工對帳用的入口。
--
-- security definer：webhook_events 的 grant 全部 revoke 掉了（0005 §329-335），
-- 呼叫端就算拿到 service_role 以外的身分也讀不到 —— 但這支函式本身仍然
-- 先 revoke 再 grant，理由是「預設不給」比「預設給了再收回」少一次犯錯機會。
create or replace function public.payment_alerts(p_days integer default 30)
returns table (
  gateway     text,
  event_key   text,
  refused     text,
  order_no    text,
  collected   integer,
  expected    integer,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    w.gateway,
    w.event_key,
    w.payload ->> 'refused'                as refused,
    coalesce(
      w.payload -> 'notify' ->> 'MerTradeNo',   -- PayUni 解密後的通知
      w.payload -> 'apn'    ->> 'order_no',     -- 黑貓 APN
      split_part(w.event_key, ':', 1)           -- 兩種 event_key 的第一段都是訂單編號
    )                                       as order_no,
    nullif(w.payload ->> 'collected', '')::integer as collected,
    nullif(w.payload ->> 'expected',  '')::integer as expected,
    w.created_at
  from public.webhook_events w
  where w.payload ? 'refused'
    and w.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
  order by w.created_at desc;
$$;

comment on function public.payment_alerts(integer) is
  '列出 webhook handler 拒絕標記付款的事件（金額不符、缺 pay_amount、找不到訂單、付款後已取消），供人工對帳。';

revoke execute on function public.payment_alerts(integer) from public;
revoke execute on function public.payment_alerts(integer) from anon, authenticated;
grant  execute on function public.payment_alerts(integer) to service_role;

-- ---------------------------------------------------------------------------
-- §4 既有表的 RLS / grant 覆核（冪等，只是把 0005 的狀態再宣告一次）
-- ---------------------------------------------------------------------------
-- 這一支沒有建新表，所以「新表要開 RLS + revoke anon/authenticated + 明確 grant」
-- 這條規矩落在這裡：把黑貓會寫到的兩張既有表重新宣告一次。全部是冪等的，
-- 目的是讓「這一期碰過哪些表、它們的授權長什麼樣」在這個檔案裡看得到，
-- 而不是要回頭翻 0005。
do $$
declare t text;
begin
  foreach t in array array['orders', 'payments', 'webhook_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

commit;

-- 驗證（套用後請跑）：
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='orders' and column_name='payment_url';
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='payments' and column_name='gateway_trans_id';
--   select * from public.payment_alerts(30);
--   -- 應該沒有任何 anon/authenticated 的 execute 權限：
--   select has_function_privilege('anon','public.payment_alerts(integer)','execute');  -- f
