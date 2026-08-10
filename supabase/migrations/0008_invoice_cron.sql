-- 0008_invoice_cron.sql — 讓 /api/tasks/invoices 真的有人打
--
-- Requires 0007 (claim/finish/fail + invoice_backlog).
--
-- ## 這支 migration 存在的唯一理由
--
-- 0007 把「開票失敗會被記下來、而且可以被安全地重試」做完了，src/server/task-endpoints.ts
-- 也把入口掛好了 —— 然後**沒有任何東西在打它**。那等於：webhook 當下開票失敗的訂單，
-- 要有人自己去跑 invoice_backlog() 才會被發現。台灣電商付了錢就要開發票，這不是
-- 「之後再補」的功能，是法遵。
--
-- 0006 的 expire_unpaid_orders() 曾經是同一個形狀的死碼（函式寫好、沒人呼叫），
-- 後來用 pg_cron 接上、實測 11 次執行 11 次成功。這裡照同一條路走。
--
-- ## 為什麼是 pg_cron + pg_net，不是 Vercel Cron
--
-- 這個 Vercel 帳號是 hobby 方案，Vercel Cron **一天只能跑一次**。開票失敗要盡快重試，
-- 一天一次等於沒有重試。pg_cron 在這個專案已經證明可用（jobid 1，每 5 分鐘準時跑），
-- 而且它跟 Vercel 的方案無關 —— 排程在資料庫，端點在哪裡都打得到。
--
-- ## ⚠️ 密鑰不可以寫進 cron.job.command
--
-- 最直覺的寫法是：
--
--     select cron.schedule('...', '...', $$select net.http_post('https://…?k=真的密鑰')$$);
--
-- 那會讓 TASKS_SECRET 以**明文**躺在 cron.job.command 裡。任何拿到這個資料庫讀權限的
-- 人（包含 Studio 的 SQL editor、任何一份 pg_dump、任何一次 support bundle）都看得到它，
-- 而那把鑰匙可以直接對一個「會開稅務憑證」的端點下指令。所以密鑰放 Supabase Vault
-- （pgsodium 加密），cron 只呼叫下面這支函式，函式在執行當下才解密。
-- 這也是 Supabase 官方對 pg_cron + pg_net 的建議做法。
--
-- 驗收方式：`select command from cron.job;` 看不到任何密鑰。
--
-- ## 套用前要先準備好的兩個 Vault secret
--
-- 這支 migration **不建立 secret**（migration 進 git，secret 不進 git）。套用之前先跑：
--
--     select vault.create_secret(
--       'https://<你的網域>/api/tasks/invoices', 'tasks_endpoint_url',
--       '補開發票排程要打的端點（不含 ?k=）');
--     select vault.create_secret(
--       '<TASKS_SECRET 的值>', 'tasks_secret',
--       '/api/tasks/invoices 的密鑰，與 Vercel 環境變數 TASKS_SECRET 相同');
--
-- 之後換網域或換密鑰用 vault.update_secret()，不需要再動 migration。
--
-- ## 為什麼缺 secret 要 raise exception 而不是安靜跳過
--
-- 安靜跳過的話，cron.job_run_details 會顯示 succeeded，而實際上一封請求都沒送出去 ——
-- 那正是這個 repo 一路在防的「綠燈但什麼都沒做」。缺設定就讓那一次執行紅掉，
-- job_run_details 的 status 會是 failed 並附上訊息，這才是誠實的狀態。
--
-- ## ⚠️ 排程「有跑」不等於「打得到」
--
-- pg_net 是非同步的：net.http_post() 只把請求排進佇列就回傳 request id，所以
-- cron.job_run_details 說 succeeded 只證明「請求被排進去了」。真正的答案在
-- net._http_response：
--
--     select r.id, r.status_code, r.content, r.created
--       from net._http_response r
--      order by r.id desc limit 5;
--
-- 上線後要看的是那裡的 status_code，不是 cron 的 status。

begin;

-- pg_net：讓資料庫自己送得出 HTTP 請求。這個專案先前只有 pg_cron，
-- 而 pg_cron 沒有辦法呼叫外部網址 —— 兩個都要。
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- dispatch_invoice_task — cron 唯一會呼叫的東西
-- ---------------------------------------------------------------------------
-- 回傳 pg_net 的 request id，可以拿去 net._http_response 查這一次的結果。
create or replace function public.dispatch_invoice_task()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
  v_req_id bigint;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name = 'tasks_endpoint_url';

  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'tasks_secret';

  -- 缺任何一個都不要「送一個打不到的請求」或「安靜什麼都不做」。前者會在端點那邊
  -- 變成一串 404（密鑰不符），後者會讓排程看起來一直是綠的。
  if v_url is null or v_secret is null then
    raise exception
      'MISSING_VAULT_SECRET: 需要 vault secret tasks_endpoint_url 與 tasks_secret 才能派發補開發票的請求（見 0008_invoice_cron.sql 檔頭）';
  end if;

  -- 密鑰走 query string，與端點的實作一致（src/server/task-endpoints.ts 的 `?k=`）。
  -- 那個端點對缺密鑰回 503、對密鑰不符回 404，兩者都不解析 body。
  --
  -- timeout 給 25 秒：一輪 backlog 最多處理 20 張，每張要往返 Amego 一次（實測單次
  -- 約 200ms），再加上 serverless 冷啟動。逾時只是我們不等答案了，請求仍然送出去，
  -- 端點那邊照樣跑完 —— 但那會在 net._http_response 留下一筆 timeout，看起來像失敗，
  -- 所以寧可等久一點。
  select net.http_post(
           url                  := v_url || '?k=' || v_secret,
           body                 := '{}'::jsonb,
           headers              := '{"content-type": "application/json"}'::jsonb,
           timeout_milliseconds := 25000
         )
    into v_req_id;

  return v_req_id;
end;
$$;

comment on function public.dispatch_invoice_task() is
  'Fires one POST at /api/tasks/invoices so failed invoices get retried. URL and secret come from Supabase Vault, never from cron.job.command. Returns the pg_net request id — look it up in net._http_response to see whether the endpoint actually answered.';

-- SECURITY DEFINER 而且會對外送出請求 —— 絕對不可以從瀏覽器的金鑰打得到。
-- public.* 的函式預設會被 PostgREST 當成 RPC 端點暴露出去，所以這裡與 0004 / 0006 /
-- 0007 一樣：從 public revoke 是關鍵的那一半，anon/authenticated 是保險。
-- service_role 也不需要 —— 呼叫它的只有 cron（以 postgres 身分執行）。
revoke execute on function public.dispatch_invoice_task() from public;
revoke execute on function public.dispatch_invoice_task() from anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
-- 排程
-- ---------------------------------------------------------------------------
-- cron.schedule(name, schedule, command) 以 name 為鍵做 upsert，所以重跑這支
-- migration 不會產生第二個 job。放在 commit 之後是因為 cron.schedule 在某些版本
-- 會自己開交易，包進上面那個 begin/commit 裡容易踩到 "cannot run inside a
-- transaction block"。
--
-- ## 為什麼是 3-53/10（每 10 分鐘，分鐘數 3,13,23,33,43,53）
--
--   * **與 expire-unpaid-orders 錯開**：那支是 `*/5`（分鐘 0,5,10,…,55），全部是 5 的
--     倍數。3,13,23,33,43,53 一個都不是，所以兩支永遠不會在同一個 tick 觸發。這件事
--     值得刻意安排：expire_unpaid_orders() 會對 orders 下列鎖，claim_invoice_issue()
--     也會（0007 的閘門 1），撞在一起雖然不會壞掉，但會讓「為什麼這一輪慢」變得難查。
--   * **不比 5 分鐘更密**：0007 的 p_stale_after 是 5 分鐘，一個死在半路的 claim 要
--     過 5 分鐘才輪得到別人接手。跑得比那更頻繁，多出來的那幾次只會拿到 'locked'
--     然後什麼都不做 —— 白打一次外部請求。
--   * **10 分鐘換到 50 分鐘的自動修復窗**：INVOICE_MAX_RETRIES 是 5，10 分鐘一次代表
--     Amego 掛掉 50 分鐘內都還能自己救回來；再久就 retries_exhausted，需要人看。這是
--     刻意的：一個真的長時間的外部故障應該要有人知道，而不是被無限重試蓋過去。
--   * **客人等最久 10 分鐘**：而且這只發生在失敗路徑上。正常情況下 webhook 收到付款
--     成功就當場開票了（src/server/payuni-webhook.ts），排程只收拾那些沒開成的。
select cron.schedule(
  'dispatch-invoice-task',
  '3-53/10 * * * *',
  $cron$select public.dispatch_invoice_task()$cron$
);
