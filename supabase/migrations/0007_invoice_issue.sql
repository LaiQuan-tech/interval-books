-- 0007_invoice_issue.sql — 開立電子發票的 claim-then-act 鎖
--
-- Requires 0005 (orders / invoices / order_post_payment_log).
--
-- ## 為什麼開發票的鎖要放在資料庫裡，而不是在 TypeScript
--
-- 0005 已經備好兩個鎖：`invoices.status` 的 `issuing` 中間狀態，以及
-- `order_post_payment_log` 的 `unique (order_id, step)`。問題是它們是兩張表：在應用層
-- 依序打兩個 PostgREST 請求，兩個請求之間就是一個空窗——A 拿到 log claim、還沒把
-- invoices 改成 issuing 的那一瞬間，B 讀到的 invoices 還是 pending。B 拿不到 log claim
-- 所以這一次不會出事，但只要往後有人「簡化」成單看 invoices 狀態，就會出事。
--
-- 發票開出去撤不回來。財政部那邊多一張就是多一張，只能再開一張作廢單去沖銷，客人的
-- 信箱裡已經躺著兩份稅務憑證了。所以這裡不接受「照順序寫就不會錯」這種等級的保證：
-- 兩個鎖必須在同一個交易裡一起成立或一起失敗，這是 plpgsql 函式天然給的，
-- 0004 的 atomic_deduct_stock 與 0006 的 expire_unpaid_orders 都是同一個理由。
--
-- ## 三道閘門，順序是有意義的
--
--   1. `select ... from orders for update` —— 用訂單列本身當序列化點。兩個並行的
--      claim 一定有一個先拿到列鎖，另一個等它 commit 後才讀得到「已經被搶走」的狀態。
--      少了這一道，兩邊會同時讀到 invoices.status='pending'，接著各自去搶 log claim
--      ——雖然 unique 仍會擋掉一個，但擋掉的那一個會誤以為「是別人做完了」，
--      而不是「我輸了這一局」，之後的分支就會開始猜。
--   2. `order_post_payment_log` 的 upsert —— insert 就是鎖。ON CONFLICT DO UPDATE 的
--      WHERE 只放行「沒完成，而且（失敗過 or claim 已經過期）」的列，所以正在跑的
--      claim 搶不走，而崩在半路的 claim 不會把這張單永遠鎖死。
--   3. `invoices` 的 CAS —— 只有 pending / failed / 過期的 issuing 才准轉成 issuing。
--
-- ## 為什麼失敗要留下痕跡而不是把 log 列刪掉
--
-- 刪掉最省事：下次 insert 就會成功。但那等於「失敗過」這件事從此不存在，一張永遠開不
-- 出來的發票會安靜地重試到天荒地老，沒有任何地方看得出來。所以失敗是
-- `error_message is not null 且 completed_at is null` ——它同時是「可以再搶」的訊號，
-- 也是「這張出過事」的證據，一句 SQL 就查得到待處理清單。
--
-- ## 不可自動重試的失敗
--
-- 統編格式錯、載具號碼不存在、金額算錯——這些重試一萬次還是同一個答案。這類失敗把
-- retry_count 直接推到上限，claim 之後一律回 retries_exhausted，需要人改資料才會再動。
-- 「無限重試打外部 API」跟「卡在 issuing 沒人知道」是同一個病的兩種症狀。

begin;

-- ---------------------------------------------------------------------------
-- claim_invoice_issue — 開票前唯一的入口
-- ---------------------------------------------------------------------------
-- 回傳 claimed=false 時 reason 說明為什麼，呼叫端據此決定要不要告警：
--   order_not_found / order_not_paid  訂單狀態不對，不該走到這裡
--   already_issued                    已經開過了（回傳發票號碼，冪等）
--   voided                            已作廢，不自動重開
--   locked                            另一個執行緒正在開，這一次什麼都不要做
--   retries_exhausted                 連續失敗到上限，等人處理
create or replace function public.claim_invoice_issue(
  p_order_id    uuid,
  p_stale_after interval default '5 minutes',
  p_max_retries integer  default 5
)
returns table (
  claimed        boolean,
  reason         text,
  invoice_id     uuid,
  attempt        integer,
  order_no       text,
  invoice_number text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  public.orders%rowtype;
  v_inv    public.invoices%rowtype;
  v_log_id bigint;
begin
  if p_order_id is null then
    raise exception 'NULL_ORDER_ID';
  end if;

  -- ---- 閘門 1：訂單列鎖，兼檢查「真的付過錢」 ---------------------------
  -- 沒付錢就開發票，是把稅務憑證開給一個還沒成立的交易。這裡再擋一次，不倚賴呼叫端。
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    return query select false, 'order_not_found', null::uuid, 0, null::text, null::text;
    return;
  end if;
  if v_order.payment_status <> 'paid' then
    return query select false, 'order_not_paid', null::uuid, 0, v_order.order_no, null::text;
    return;
  end if;

  -- 舊訂單（0005 建表前後、或還沒有結帳發票欄位的那批）不一定有 invoices 列。
  -- 建立預設列，而不是回報「查無資料」——沒有那一列不是不能開發票的理由。
  insert into public.invoices (order_id) values (p_order_id)
  on conflict (order_id) do nothing;

  select * into v_inv from public.invoices i where i.order_id = p_order_id;

  if v_inv.status = 'issued' then
    return query select false, 'already_issued', v_inv.id, v_inv.retry_count,
                        v_order.order_no, v_inv.invoice_number;
    return;
  end if;
  if v_inv.status = 'voided' then
    return query select false, 'voided', v_inv.id, v_inv.retry_count,
                        v_order.order_no, v_inv.invoice_number;
    return;
  end if;
  if v_inv.status = 'failed' and v_inv.retry_count >= p_max_retries then
    return query select false, 'retries_exhausted', v_inv.id, v_inv.retry_count,
                        v_order.order_no, null::text;
    return;
  end if;

  -- ---- 閘門 2：post-payment log 的 claim ---------------------------------
  -- 只有「沒完成，而且（上次失敗過 or claim 已過期）」的列准被接手。正在跑的 claim
  -- 兩個條件都不符，於是 DO UPDATE 一列也不影響，RETURNING 沒有列，v_log_id 是 NULL。
  insert into public.order_post_payment_log (order_id, step)
  values (p_order_id, 'invoice')
  on conflict (order_id, step) do update
     set claimed_at = now(), error_message = null
   where order_post_payment_log.completed_at is null
     and (order_post_payment_log.error_message is not null
          or order_post_payment_log.claimed_at < now() - p_stale_after)
  returning id into v_log_id;

  if v_log_id is null then
    return query select false, 'locked', v_inv.id, v_inv.retry_count, v_order.order_no, null::text;
    return;
  end if;

  -- ---- 閘門 3：invoices 的 CAS ------------------------------------------
  -- 過期的 issuing 也放行：程序在呼叫 Amego 途中被砍掉時，狀態會永遠停在 issuing，
  -- 沒有這一條就再也沒有人能接手（而客人的發票也永遠不會開出來）。
  update public.invoices i
     set status = 'issuing', locked_at = now(), error_message = null
   where i.id = v_inv.id
     and (i.status in ('pending', 'failed')
          or (i.status = 'issuing'
              and (i.locked_at is null or i.locked_at < now() - p_stale_after)))
  returning * into v_inv;

  if not found then
    return query select false, 'locked', v_inv.id, coalesce(v_inv.retry_count, 0),
                        v_order.order_no, null::text;
    return;
  end if;

  return query select true, 'claimed', v_inv.id, v_inv.retry_count, v_order.order_no, null::text;
end;
$$;

comment on function public.claim_invoice_issue(uuid, interval, integer) is
  '開發票前的原子 claim：訂單列鎖 + order_post_payment_log 佔位 + invoices CAS，三者同一交易。claimed=true 才可以呼叫 Amego。';

-- ---------------------------------------------------------------------------
-- finish_invoice_issue — Amego 回 code 0 之後
-- ---------------------------------------------------------------------------
-- 這裡是「一張訂單開出兩張發票」的絆線。已經是 issued 而且號碼不同，代表真的多開了
-- 一張稅務憑證；那不是可以 log 一行帶過的事，直接 raise，讓呼叫端的錯誤路徑吵起來。
create or replace function public.finish_invoice_issue(
  p_order_id       uuid,
  p_invoice_number text,
  p_random_code    text default null,
  p_issued_at      timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices%rowtype;
begin
  if p_invoice_number is null or length(btrim(p_invoice_number)) = 0 then
    raise exception 'EMPTY_INVOICE_NUMBER';
  end if;

  select * into v_inv from public.invoices i where i.order_id = p_order_id for update;
  if not found then
    raise exception 'INVOICE_ROW_MISSING:%', p_order_id;
  end if;

  if v_inv.status = 'issued' then
    if v_inv.invoice_number is distinct from p_invoice_number then
      -- 同一張訂單、兩個發票號碼。claim 沒擋住，或有人繞過 claim 直接打 Amego。
      raise exception 'DOUBLE_ISSUE:% existing=% incoming=%',
        p_order_id, v_inv.invoice_number, p_invoice_number;
    end if;
    -- 同一個號碼再寫一次：重送而已，當成成功。
    return false;
  end if;

  update public.invoices i
     set status         = 'issued',
         invoice_number = p_invoice_number,
         random_code    = coalesce(p_random_code, i.random_code),
         issued_at      = coalesce(p_issued_at, now()),
         error_message  = null,
         locked_at      = null
   where i.id = v_inv.id;

  update public.order_post_payment_log l
     set completed_at  = now(),
         error_message = null
   where l.order_id = p_order_id
     and l.step = 'invoice';

  return true;
end;
$$;

comment on function public.finish_invoice_issue(uuid, text, text, timestamptz) is
  '記錄開立成功並結掉 claim。同一訂單出現第二個發票號碼時 raise DOUBLE_ISSUE。';

-- ---------------------------------------------------------------------------
-- fail_invoice_issue — 開立失敗
-- ---------------------------------------------------------------------------
-- p_permanent = true 代表重試沒有意義（統編格式錯、金額算錯、載具不存在）：直接把
-- retry_count 推到上限，之後的 claim 一律回 retries_exhausted。
--
-- 兩種失敗都會留下 `completed_at is null 且 error_message is not null` 的 log 列，
-- 這就是待處理清單的查詢條件，也是允許下一次 claim 接手的條件。
create or replace function public.fail_invoice_issue(
  p_order_id    uuid,
  p_error       text,
  p_permanent   boolean default false,
  p_max_retries integer default 5
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_retry integer;
begin
  update public.invoices i
     set status        = 'failed',
         error_message = left(coalesce(p_error, 'unknown'), 500),
         retry_count   = case when p_permanent
                              then greatest(i.retry_count + 1, p_max_retries)
                              else i.retry_count + 1
                         end,
         locked_at     = null
   where i.order_id = p_order_id
     and i.status <> 'issued'
  returning retry_count into v_retry;

  update public.order_post_payment_log l
     set error_message = left(coalesce(p_error, 'unknown'), 500)
   where l.order_id = p_order_id
     and l.step = 'invoice'
     and l.completed_at is null;

  return coalesce(v_retry, -1);
end;
$$;

comment on function public.fail_invoice_issue(uuid, text, boolean, integer) is
  '記錄開立失敗並釋放 claim（留下 error_message 當待處理標記）。p_permanent 把 retry_count 推到上限，停止自動重試。';

-- ---------------------------------------------------------------------------
-- reclaim_stale_invoices — 把卡在 issuing 的撿回來
-- ---------------------------------------------------------------------------
-- claim_invoice_issue 本身就會接手過期的 issuing，所以這支函式不是正確性必需品，
-- 而是誠實性必需品：程序被砍掉之後，`issuing` 這個狀態說的是「現在有人正在開」，
-- 而那是假的。0005 的 invoices_pending_idx 是 partial index
-- （status in ('pending','failed')），任何照著它寫的監控查詢都看不到卡住的列；
-- 人工在後台掃 status='failed' 也看不到。撥回 failed 並寫上 error_message，
-- 這一列才會同時出現在索引、待處理清單與人的眼睛裡。
create or replace function public.reclaim_stale_invoices(
  p_stale_after interval default '5 minutes',
  p_limit       integer  default 100
)
returns table (reclaimed_order_id uuid, reclaimed_order_no text, stuck_since timestamptz)
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

  select array_agg(c.id) into v_ids
    from (
      select i.id
        from public.invoices i
       where i.status = 'issuing'
         and (i.locked_at is null or i.locked_at < now() - p_stale_after)
       order by i.locked_at nulls first
       limit p_limit
         for update skip locked
    ) c;

  if v_ids is null or cardinality(v_ids) = 0 then
    return;
  end if;

  return query
  with moved as (
    update public.invoices i
       set status        = 'failed',
           error_message = 'stale_issuing_reclaimed',
           locked_at     = null
     where i.id = any(v_ids)
    returning i.order_id, i.locked_at
  ),
  released as (
    update public.order_post_payment_log l
       set error_message = 'stale_issuing_reclaimed'
     where l.step = 'invoice'
       and l.completed_at is null
       and l.order_id in (select m.order_id from moved m)
    returning l.order_id, l.claimed_at
  )
  select m.order_id, o.order_no, r.claimed_at
    from moved m
    join public.orders o on o.id = m.order_id
    left join released r on r.order_id = m.order_id;
end;
$$;

comment on function public.reclaim_stale_invoices(interval, integer) is
  '把卡在 issuing 超過 p_stale_after 的發票撥回 failed，讓它重新出現在待處理清單裡。純為可觀測性存在。';

-- ---------------------------------------------------------------------------
-- invoice_backlog — 該開卻還沒開的訂單
-- ---------------------------------------------------------------------------
-- 已付款、發票不是 issued/voided、且還沒重試到上限。worker 與人工排查共用同一個定義，
-- 免得「排程認為沒事、後台卻看得到卡住的單」。
--
-- 新鮮的 issuing 被排除（真的有人正在開，worker 進去只會拿到 locked），過期的 issuing
-- 則留在清單裡——那正是需要被看見的那一種。
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
     and coalesce(i.status, 'missing') not in ('issued', 'voided')
     and coalesce(i.retry_count, 0) < p_max_retries
     and not (i.status = 'issuing'
              and i.locked_at is not null
              and i.locked_at > now() - p_stale_after)
   order by o.paid_at nulls last
   limit greatest(p_limit, 0);
$$;

comment on function public.invoice_backlog(integer, integer, interval) is
  '已付款但發票還沒開成功的訂單。worker 與人工排查的共同定義。';

-- ---------------------------------------------------------------------------
-- 權限：SECURITY DEFINER，所以絕不能讓瀏覽器的金鑰碰得到
-- ---------------------------------------------------------------------------
-- 與 0004 / 0006 相同處理：execute 預設就 grant 給 public，所以「從 public revoke」
-- 才是真正生效的那一半，anon/authenticated 是保險。
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.claim_invoice_issue(uuid, interval, integer)',
    'public.finish_invoice_issue(uuid, text, text, timestamptz)',
    'public.fail_invoice_issue(uuid, text, boolean, integer)',
    'public.reclaim_stale_invoices(interval, integer)',
    'public.invoice_backlog(integer, integer, interval)'
  ]
  loop
    execute format('revoke execute on function %s from public', sig);
    execute format('revoke execute on function %s from anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end loop;
end $$;

commit;
