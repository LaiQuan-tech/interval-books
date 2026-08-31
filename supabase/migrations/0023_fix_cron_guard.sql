-- 0023_fix_cron_guard.sql —— 修好一個讓排程靜默不建立的守衛
--
-- 前一支是 0022_email_outbox_notify.sql。既有 0001–0022 一律不動（規約：已套用的
-- migration 永不修改），所以這裡用一支新的來修。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 問題：to_regproc() 不吃簽名，帶括號就永遠回 null
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0020 §3 與 0022 §9 都用同一個守衛判斷「這個資料庫有沒有 pg_cron」：
--
--     if to_regproc('cron.schedule(text,text,text)') is null then
--       raise warning '沒有 pg_cron，跳過排程';
--       return;
--     end if;
--
-- **`to_regproc()` 只接受函式名稱，不接受參數列。** 帶括號的字串它解析不了，
-- 回傳 null 而不是報錯。所以那個守衛在**每一台機器上**都成立 —— 包含正式庫。
-- 兩支 migration 的排程段從來沒有執行過，而且只印 warning，看起來像成功。
--
-- 正式庫實測：
--     to_regproc('cron.schedule(text,text,text)')      → null
--     to_regprocedure('cron.schedule(text,text,text)') → cron.schedule(text,text,text)
--
-- 帶簽名要用 `to_regprocedure()`。（不帶簽名的 `to_regproc('cron.schedule')` 也
-- 回 null，因為 cron.schedule 有兩個 overload，名稱本身是模稜兩可的 —— 所以
-- 「把括號拿掉」不是修法。）
--
-- 這是這個專案第二次踩到同一類失敗模式：**看起來有防護、其實沒有，而且不報錯。**
-- 前兩次是遮罩函式的 slice(-0)（0021 §2）與 CSV 的 forceText 漏引號（58aec58）。
-- 所以這一支除了修，還在 scripts/notify-selftest.mjs 加了一條靜態斷言，掃全部
-- migration：出現 `to_regproc('…(` 就紅。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ 這一支刻意「只補不存在的，不動已存在的」
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 因為修好守衛之後才發現：線上的 expire-unpaid-orders 跑的是
--
--     select public.expire_unpaid_orders(interval '2 hours')
--
-- 而 0020 寫的是不帶參數（函式預設 30 分鐘）。那筆 job 是 0008 時期手動建的，
-- 兩小時是有人**刻意**設的。守衛要是當初有效，0020 就會把未付款訂單的保留時間
-- 從 2 小時悄悄改成 30 分鐘 —— 客人用 ATM 轉帳來不及付款，訂單就被取消了。
--
-- cron.schedule() 以 name 為鍵 upsert，所以「重跑就收斂到宣告的狀態」這件事在
-- 這裡是危險的，不是優點。這支只在 job 不存在時才建立；已經在跑的一律不碰，
-- 並把差異印成 notice 讓人自己決定。
--
-- 30 分鐘 vs 2 小時要不要統一，是營運決定不是技術決定，留給人。

do $$
declare
  v_missing text[] := '{}';
  v_existing text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise warning '[0023] 這個資料庫沒有 pg_cron，跳過排程檢查（本機測試庫是正常的）';
    return;
  end if;

  -- expire-unpaid-orders：只在不存在時建立
  select command into v_existing from cron.job where jobname = 'expire-unpaid-orders';
  if v_existing is null then
    perform cron.schedule('expire-unpaid-orders', '*/5 * * * *',
      'select public.expire_unpaid_orders()');
    v_missing := v_missing || 'expire-unpaid-orders';
  elsif v_existing !~ 'expire_unpaid_orders\(\)' then
    raise notice '[0023] expire-unpaid-orders 已存在且與 0020 宣告的不同，保留現況：%', v_existing;
  end if;

  -- dispatch-invoice-task：只在不存在時建立
  select command into v_existing from cron.job where jobname = 'dispatch-invoice-task';
  if v_existing is null then
    perform cron.schedule('dispatch-invoice-task', '3-53/10 * * * *',
      'select public.dispatch_invoice_task()');
    v_missing := v_missing || 'dispatch-invoice-task';
  end if;

  -- dispatch-notify-task：只在不存在時建立（0022 §9 本來要建，被守衛擋掉了）
  select command into v_existing from cron.job where jobname = 'dispatch-notify-task';
  if v_existing is null then
    perform cron.schedule('dispatch-notify-task', '6-56/10 * * * *',
      'select public.dispatch_notify_task()');
    v_missing := v_missing || 'dispatch-notify-task';
  end if;

  if array_length(v_missing, 1) is null then
    raise notice '[0023] 三支排程都在，沒有補建任何一支。';
  else
    raise notice '[0023] 補建了：%', array_to_string(v_missing, ', ');
  end if;
end $$;

-- 驗證（套用後請跑）：
--   select jobname, schedule, command from cron.job order by jobname;
-- 應該有三筆：dispatch-invoice-task / dispatch-notify-task / expire-unpaid-orders
