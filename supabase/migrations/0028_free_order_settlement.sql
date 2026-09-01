-- 0028_free_order_settlement.sql —— 免費訂單（total = 0）的結算
--
-- 前一支是 0027_event_blocks.sql。既有 0001–0027 一律不動（規約：已套用的
-- migration 永不修改），所以要加的東西都用這一支新的來加。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 這一支在修什麼：**免費活動的報名會靜默消失**
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 這不是新功能，是一條正在掉資料的路徑。事實鏈如下，每一環都可以自己去查：
--
--   1. 結帳路徑對 total = 0 沒有任何處理。src/server/repos/orders.ts 的
--      createOrder() 一律把訂單留在 status='pending' / payment_status='pending'
--      （那個檔案第 766-770 行明著寫「這裡永遠不可以寫 payment_status='paid'，
--      那是 webhook 的事」），然後把訂單交給金流。免費訂單沒有金流可以交，
--      於是它就停在 pending。
--
--   2. public.expire_unpaid_orders()（0006:115，0011 與 0020 各重寫過一次）挑的是
--
--          status = 'pending' and payment_status <> 'paid' and paid_at is null
--
--      免費訂單**永遠**符合這三條。
--
--   3. 正式庫上有一個每 5 分鐘跑一次的 pg_cron 在呼叫它（0020 檔頭記著）。
--
--   4. 0020 §4c（0020:783）在取消訂單**之前**跑這一句：
--
--          with freed as (delete from public.event_registrations r
--                          where r.order_id = any(v_ids) returning r.session_id) …
--          update public.event_sessions set seats_taken = greatest(0, seats_taken - n)
--
--      逐位參加者被刪掉、座位被還回去，兩件事在同一句裡。
--
--   所以：客人報名免費活動 → 30 分鐘後訂單被當成「沒付錢」取消 → **報名紀錄被刪、
--   座位被還回去**。全程沒有任何錯誤訊息，畫面上看起來一切正常，只是那個人不在
--   名單上了。
--
--   ⚠️ 這裡刻意不寫成「order_items 被刪，registrations 跟著 cascade 消失」。
--      event_registrations.order_item_id 確實是 on delete cascade（0020:115），但
--      **過期路徑不走那條**：expire_unpaid_orders() 只把訂單 update 成 'cancelled'，
--      order_items 一列都沒刪（實測：對照組跑完之後 order_items 還在、
--      registrations 已經是 0）。cascade 是結帳失敗時 deleteOrder() 走的路。
--      兩條路的結果一樣，但寫錯機制會讓下一個人去修錯的地方。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 為什麼「把免費訂單標成 paid」單獨做完會製造第二個災難
-- ═══════════════════════════════════════════════════════════════════════════
--
-- public.invoice_backlog()（0007:362）挑的是
--
--     o.payment_status = 'paid' and coalesce(i.status,'missing') not in ('issued','voided')
--
-- **沒有 total > 0 這個條件。** 而 0004 的結帳流程對每一張訂單都會寫一列 invoices
-- （orders.ts step 4b），所以免費訂單一旦變成 paid，下一次發票排程就會拿著它去
-- Amego 開一張 **NT$0 的電子發票**。那是對外的、開給財政部的、要作廢才收得回來的
-- 東西。把「靜默掉單」換成「對外開錯發票」不是修好。
--
-- 所以 §2（標成 paid）與 §3（發票排除）必須在同一支 migration 裡，不可以分兩期。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 免費訂單要落在哪一個狀態：**跟刷卡付款成功的訂單一模一樣**
-- ═══════════════════════════════════════════════════════════════════════════
--
-- src/server/repos/payments.ts 的 markOrderPaid() 收到金流的付款通知之後寫的是
--
--     status = 'processing', payment_status = 'paid', payment_method = 'card', paid_at = now()
--
-- §2 寫的是同一組，只有 payment_method 不同（'free'）。這是刻意的，而且是這一支
-- 最重要的設計決定：**不要發明新的狀態組合。**
--
-- 理由是下游。「已付款的訂單」在這個 schema 裡有一大票消費者 —— 0021 §3 的
-- admin_event_roster（on_roster = payment_status = 'paid'，簽到表與 CSV 匯出都讀
-- 它）、0022 §8 的 claim_order_notify（報名成功信的前提）、0022 §9 的
-- notify_backlog、0007 的發票、後台訂單清單、確認頁的 awaitingPayment。每多一個
-- 新的狀態組合，就等於要求上面每一個消費者都被重新檢查一次；而漏掉的那一個不會
-- 報錯，它只會安靜地把免費訂單當成不存在 —— 那正是這一支要修掉的那種壞法。
--
-- 落在同一組狀態的話，那些消費者一行都不用改，而且行為是對的：
--
--   · admin_event_roster.on_roster → true。**免費報名的人本來就該在簽到表上。**
--   · claim_order_notify → 過。報名成功信（registration_ticket）本來就該寄。
--     ⚠️ 順帶一提：0022 §8 那一封「付款成功信」（order_paid）也會一起排出去。
--        它的文案在 public.email_copy 裡（目前還是「（待補：…）」的佔位文字），
--        改文案不需要動程式也不需要重新部署。**這裡刻意不在 SQL 或程式裡把它擋
--        掉**：擋掉的話買家對這張訂單就完全沒有任何書面紀錄，那是把「靜默掉單」
--        換成「靜默沒有確認信」，同一種壞法。要處理的是文案措辭（讓它同時說得通
--        「已付款」與「免費報名」），那是資料不是程式。
--   · invoice_backlog → **排除**，見 §3。這是唯一一個必須排除的。
--
-- ── 為什麼 payment_method 要加 'free' 而不是沿用 NULL ──────────────────────
--
-- 目前非刷卡路徑寫的是 NULL（orders.ts:829），而 NULL 在這個 schema 裡有一個既有
-- 且明確的意思：「沒有經過金流，由店家另行安排付款」——也就是**還有人欠我們錢**。
-- 免費訂單的事實是「沒有錢要收」。兩件事不一樣，而且不一樣的地方正是店員會拿來
-- 行動的地方。沿用 NULL 的話，兩者只能靠 total 與 payment_status 去推論；推論得
-- 出來不代表推論得對 —— 任何一句日後寫成「payment_method is null ＝ 這筆要去追款」
-- 的查詢都會靜默把免費訂單一起撈進去。
--
-- 0005 的 CHECK 已經有 'test_paid' 這個前例（沙盒付款，也是「沒有真的過金流但已
-- 結清」）。'free' 是同一類，加進去而不是硬塞進 NULL。
--
-- ⚠️ drop + add 是因為 CHECK 沒有 create or replace。`drop constraint if exists`
--    讓這一段重複套用是安全的（第二次會把自己剛加的那條先拿掉再加回去）。
--    ADD CONSTRAINT 會全表掃描驗證一次並拿 ACCESS EXCLUSIVE 鎖 —— 新的條件比舊的
--    **寬**（只是多一個允許值），所以既有的每一列都必定通過，不會有 migration 套到
--    一半失敗的情況。正式庫目前 0 筆訂單，掃描是瞬間的；日後表大了要改成
--    `not valid` + `validate constraint` 才不會擋寫入。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 這一支**不動** expire_unpaid_orders()
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 直覺上會想在它的 claim 加一條 `and o.total > 0`，當作第二層保險。刻意不做：
--
--   1. 那支函式被 0006 → 0011 → 0020 重寫過三次，現在的版本有一百多行（要同時處理
--      products 的庫存、inv 的預留、event_sessions 的座位）。為了加一個述詞而把它
--      整份抄第四次，抄錯一行就是庫存或座位漏回補，而那種錯是靜默的。
--   2. 更重要的是它會製造一個**新的**隱形洞：萬一 §2 沒被呼叫到（結帳路徑出錯），
--      那張免費訂單會永遠停在 pending，佔著座位，而且因為 on_roster 要求 paid，
--      它**不會出現在簽到表上**。一個沒有人看得到、也永遠不會被回收的座位，比
--      現在這個「被回收掉」還難發現。
--
-- 這一支選的是另一個方向：結帳路徑呼叫 §2 失敗時就讓整筆結帳失敗（訂單被刪掉、
-- 座位還回去、客人看到「請再試一次」）。見 src/server/repos/orders.ts step 5b。
-- 沒有半吊子的狀態，就不需要保險。

begin;

-- ---------------------------------------------------------------------------
-- §1  orders.payment_method 認得 'free'
-- ---------------------------------------------------------------------------
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method is null
         or payment_method in ('card', 'atm', 'cvs_cod', 'test_paid', 'free'));

comment on column public.orders.payment_method is
  '這張訂單怎麼結清的。NULL ＝ 沒有經過金流、由店家另行安排付款（還有錢要收）；''free'' ＝ total = 0，沒有錢要收（0028）；''test_paid'' ＝ 沙盒。兩者意思不同，不要合併。';

-- ---------------------------------------------------------------------------
-- §2  settle_free_order —— 把一張 total = 0 的訂單推到終局狀態
-- ---------------------------------------------------------------------------
--
-- 由結帳路徑在訂單建立完成之後呼叫一次（src/server/repos/orders.ts step 5b）。
--
-- ⚠️ **金額從資料庫的那一列讀，不從參數讀。** 只吃 p_order_id，沒有第二個參數。
--    這條規則跟 src/lib/checkout-fns.ts 檔頭第 1 點是同一條：呼叫端不可以有任何
--    辦法宣稱「這張單是免費的」。這支函式是 security definer 而且能把訂單標成
--    已付款，一個 p_total 參數就等於一個「幫我把這張三千塊的單標成付清」的入口。
--
-- ⚠️ 閘門 1（orders 的列鎖）形狀抄 0022 §8 的 claim_order_notify：用訂單列本身當
--    序列化點，兩個並行的呼叫一定有一個先拿到鎖，後到的那個讀到的是已經改完的值。
--
-- 回傳三欄而不是 boolean，理由與 claim_order_notify 相同：呼叫端要分得出
-- 「我做的」與「已經是那樣了」與「這張單根本不該走這條路」。
create or replace function public.settle_free_order(p_order_id uuid)
returns table (
  settled  boolean,
  reason   text,
  order_no text
)
language plpgsql
security definer
set search_path = public
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

  -- ---- 閘門 2：真的是免費訂單嗎 -------------------------------------------
  -- 這是整支函式唯一在乎的事實，而且它只從這一列讀得到。
  if v_order.total <> 0 then
    return query select false, 'order_not_free', v_order.order_no;
    return;
  end if;

  -- 已經結清了 —— 冪等成功。結帳路徑的 idempotency_key 重播會走到這裡。
  if v_order.payment_status = 'paid' then
    return query select false, 'already_settled', v_order.order_no;
    return;
  end if;

  -- 取消掉的、失敗的、已經在出貨的，都不准被推回 paid。
  if v_order.status <> 'pending' or v_order.payment_status <> 'pending' then
    return query select false, 'order_not_pending', v_order.order_no;
    return;
  end if;

  -- ---- 寫入 --------------------------------------------------------------
  -- 述詞在列已經被鎖住的情況下重述一次。跟 0006 步驟 5 的理由一樣：不花成本，而且
  -- 日後有人改上面的判斷式時，這一句不會悄悄變成「不管三七二十一標成付清」。
  update public.orders o
     set status         = 'processing',
         payment_status = 'paid',
         payment_method = 'free',
         paid_at        = now()
   where o.id = p_order_id
     and o.total = 0
     and o.status = 'pending'
     and o.payment_status = 'pending';

  if not found then
    return query select false, 'order_not_pending', v_order.order_no;
    return;
  end if;

  return query select true, 'settled', v_order.order_no;
end;
$$;

comment on function public.settle_free_order(uuid) is
  'total = 0 的訂單沒有金流可以走，這支把它直接推到「已付款」的終局狀態（狀態組合與 markOrderPaid 完全相同，只有 payment_method = ''free''），免得 expire_unpaid_orders() 把它連同 event_registrations 一起 cascade 掉。金額只從資料庫那一列讀，呼叫端無法宣稱一張單是免費的。冪等：第二次回 already_settled。';

-- SECURITY DEFINER，而且它能把訂單標成已付款 —— 絕不能讓瀏覽器的金鑰碰得到。
-- 與 0004 / 0006 / 0007 相同處理：execute 預設就 grant 給 public，所以「從 public
-- revoke」才是真正生效的那一半，anon/authenticated 是保險。
revoke execute on function public.settle_free_order(uuid) from public;
revoke execute on function public.settle_free_order(uuid) from anon, authenticated;
grant  execute on function public.settle_free_order(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- §3  invoice_backlog 只挑真的有金額的訂單
-- ---------------------------------------------------------------------------
--
-- 逐字照抄 0007:338 的版本，只加一行 `and o.total > 0`。
--
-- ⚠️ 底下每一行都要與 0007 對得起來（RETURNS TABLE 的六欄、三個參數的預設值、
--    order by、limit greatest(...)）。create or replace 不能改 RETURNS TABLE 的形狀，
--    所以形狀變了會直接報錯而不是靜默生效 —— 那是好事，但參數預設值與排序改掉是
--    **不會**報錯的，那才是要盯的地方。
--
-- 為什麼是 total > 0 而不是 payment_method <> 'free'：發票要不要開，取決於**這筆
-- 交易有沒有金額**，不是取決於它怎麼結清的。日後若出現「全額折扣券折到 0 元」
-- 之類的路徑，它的 payment_method 不會是 'free'，但它同樣不該開 NT$0 的發票。
create or replace function public.invoice_backlog(
  p_limit       integer  default 50,
  p_max_retries integer  default 5,
  p_stale_after interval default '5 minutes'
)
returns table (
  order_id      uuid,
  order_no      text,
  paid_at       timestamptz,
  status        text,
  retry_count   integer,
  error_message text
)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.order_no, o.paid_at,
         coalesce(i.status, 'missing'),
         coalesce(i.retry_count, 0),
         i.error_message
    from public.orders o
    left join public.invoices i on i.order_id = o.id
   where o.payment_status = 'paid'
     and o.total > 0
     and coalesce(i.status, 'missing') not in ('issued', 'voided')
     and coalesce(i.retry_count, 0) < p_max_retries
     and not (i.status = 'issuing'
              and i.locked_at is not null
              and i.locked_at > now() - p_stale_after)
   order by o.paid_at nulls last
   limit greatest(p_limit, 0);
$$;

comment on function public.invoice_backlog(integer, integer, interval) is
  '已付款、**且金額大於 0**、但發票還沒開成功的訂單。worker 與人工排查的共同定義。total > 0 是 0028 加的：免費訂單（0028 的 settle_free_order）也是 payment_status = ''paid''，少了這一條就會拿去 Amego 開一張 NT$0 的電子發票。';

-- create or replace 會保留既有權限，這幾句是防守：萬一有人在別的地方 drop 過再建，
-- 這一支套完之後權限一定還是對的（0007 的 do-block 對五支函式做過同一件事）。
revoke execute on function public.invoice_backlog(integer, integer, interval) from public;
revoke execute on function public.invoice_backlog(integer, integer, interval) from anon, authenticated;
grant  execute on function public.invoice_backlog(integer, integer, interval) to service_role;

commit;
