# 三專案對齊差異報告

標準：**realreal**（已上線的完整電商）
比對對象：**goodday**（已上線收錢，有電商無發票無物流）、**alice-store / interval-books**（內容站 + CMS，無交易功能）

調查日期：2026-08-09

---

## 一、goodday 正在收錢，這三件事該立刻處理

### A1. 庫存超賣 —— 已確認的資料正確性 bug

`web/src/app/api/orders/route.ts:423-428`。先在 `:127` 讀出 `p.stock`，數百行後寫回**絕對值** `stock: p.stock - line.quantity`，用 `.gte("stock", line.quantity)` 當守衛。兩個問題疊在一起：

1. `.gte` 只保證「更新當下庫存 ≥ 要扣的量」，不保證那個快照還有效。兩筆併發訂單都讀到 stock=5、都買 3 件、都通過 `.gte(3)`、都寫入 `stock=2` → **賣出 6 件、庫存顯示 2 件，帳面看不出來**。
2. 更嚴重：那句 `await supabase...` 的**回傳值完全沒接、沒檢查 error、沒檢查 count**。就算 `.gte` 真的擋掉（0 rows updated），程式照樣往下走、訂單照樣成立、照樣導去 PayUni 收錢。這是「靜默」的來源。

**同一支檔案裡的課程名額卻做對了** —— `reserve_course_seat()` 有 `FOR UPDATE` 列鎖，搶不到位子刪單回 409（`:402-407`）。兩套標準並存，代表是遺漏不是能力問題，補起來很快。

realreal 的正解：`atomic_deduct_stock()`（`packages/db/migrations/0028_audit_foundation.sql:85-123`）—— 排序後 `FOR UPDATE` 鎖住（順序一致避免死鎖），單語句相對扣減 `SET stock_qty = stock_qty - qty WHERE stock_qty >= qty`，任一筆 `ROW_COUNT=0` 就 `RAISE EXCEPTION` 回滾整個交易。

### A2. 排程沒有任何失敗處理

`api/src/index.ts:32-34` 是裸 `setInterval(1小時)` + `.catch(console.error)`。process 重啟就漏掉那小時、寄信失敗只寫 console、Resend 掛掉沒有重試也沒有退避。

目前跑的是報價提醒、訂單催款、**點數到期沖銷**、課程保留位回收。**點數到期沖銷漏跑等於客人多拿點數，是會計問題。**

### A3. 無錯誤追蹤

已上線收錢卻沒有 Sentry（全 repo grep 無）。金流出錯只會留在 console log 裡，沒人主動知道。

realreal 不只有 Sentry，還把 error/fatal 鏡射到 LINE Notify（`apps/api/src/sentry.ts:12-21`）——因為 owner 不會盯 Sentry inbox。

---

## 二、總覽表

| 維度 | goodday 落差 | alice-store 落差 |
|---|---|---|
| 架構 | 名為 monorepo 實為單體：`api/` 只有 183 行（是排程器不是 API），電商邏輯全在 Next.js route handlers | 單一 Vite app on Vercel，無常駐 process，「後端」是 server functions |
| 密鑰管理 | `settings` 表存**明文** JSON，無加密 | 只有 4 個 env、無加密表；但已正確處理 `VITE_` 前綴會把 secret 編進 client bundle 的陷阱 |
| 資料層 | 無 ORM + 13 支手寫 migration；RLS 16 張表全覆蓋，**不落後** | 3 支 migration；RLS 寫法**比 realreal 嚴謹**（每表明列 deny policy，不靠隱性 deny） |
| Webhook 驗簽 | **不落後**。PayUni 三層防禦，且驗簽在解密之前，紀律比 realreal 部分 handler 還好 | 無 webhook |
| Webhook 去重 | 有 `webhook_events` 表但不用它去重，改靠 CAS；只保護「轉 paid」一個轉移 | 無 |
| 防降級守衛 | 有等價物（`TERMINAL_STATUSES` 短路） | 無 |
| 金額竄改防護 | **不落後**。下單價格後端重查 + webhook 反查金額比對 | 無 |
| 冪等鍵 | 有 unique key，但不存 response body 供重播 | 無 |
| 庫存超賣 | **真洞，見 A1** | 無庫存概念 |
| 非同步工作 | 無佇列、無重試、無退避、無死信、無告警；冪等靠在 `note` 欄位塞字串 | 完全沒有，且架構上跑不了常駐 worker |
| 測試 | **零** | **零**（playwright 在 devDependencies 但無 spec、CI 不跑） |
| 可觀測性 | 只有 `console.*`、無 Sentry、無稽核表 | 同左 |
| 前台功能 | i18n zh/en、購物車、會員、點數、等級、課程；無優惠券 | i18n **zh/en/ja 三語，三者最強**（realreal 完全無 i18n）；交易相關全無 |
| 開發流程 | CI 跑 lint + typecheck + build，**比 realreal 完整** | CI 只跑三語 meta 稽核（做得很細），**不跑 lint/typecheck/build**；無 docs/ |

---

## 三、alice-store 做電商前，架構上必須先決定的三件事

### 1. 不建議改 turbo monorepo

goodday 就是反例：硬切 `web/` + `api/` 兩個 workspace，結果 `api/` 只有 183 行、所有電商邏輯還是留在 web 裡，白白多一層建置複雜度。

建議改為**單 app + 清楚的目錄邊界**：新開 `src/server/commerce/**`，與 `src/server/repos/**` 平行但授權模型不同。理由是電商的寫入來自**未登入的客人**（下單）與**外部系統**（webhook），兩者都不能走 `adminFnMiddleware`。

但 webhook 必須是**真的 HTTP route**，不能是 server function —— 金流商 POST 過來的是固定 URL 的 form-urlencoded，不是 `/_serverFn/` 呼叫。

### 2. 非同步工作跑在哪 —— 唯一真正卡住的問題

開發票（Amego）與建物流單（ECPay）**不能塞進 webhook 的同步流程**：Amego 掛掉會讓金流商收到 5xx 而不斷重送，realreal 就是因此才拆出 `enqueue-post-payment` + worker。

| 選項 | 說明 |
|---|---|
| (a) Vercel Cron + DB 當佇列 | 付款成功寫一筆待辦，Cron 每分鐘掃。零新增基礎設施，延遲最多 60 秒，重試要自己寫。**書店量級最推薦** |
| (b) Railway worker service | 跟 realreal 一樣 BullMQ + Redis。對齊度最高，但要多養 Redis + 一個 service |
| (c) 同步做只加 fail-safe | **不建議**，realreal 修過的坑 |

不管選哪個，`order_post_payment_log` 那張 **claim-then-act 稽核表**都要抄 —— 它用「先 claim 才執行」序列化併發呼叫者，是 realreal 修掉「點數重複核發 / 等級重複升級」的關鍵，與佇列選型無關。

### 3. 交易表的 RLS 必須「預設拒絕」，不能沿用現在的 public read

現在的 pattern 是「每張表 public select + 明列三個 deny 寫入」，對 CMS 內容完全正確。但 `orders` / `order_items` / `payments` / `invoices` / `logistics` **絕對不能 public select**。

realreal 就是這樣外洩的 —— `0036_CRITICAL_enable_rls.sql` 檔頭寫得很清楚：RLS 全關而瀏覽器握著 anon key，任何人 `GET /rest/v1/order_addresses` 就能把全部客人的姓名電話地址拉光。

alice-store 的 policy 紀律本來就比另外兩個好，只要新表**沿用同樣寫法但把 select 也 deny 掉**（訂單查詢一律走 server function + `public_token`）即可。這必須在寫第一張訂單表的 migration 時就做對。

---

## 四、三個專案的共通問題（包含標準本身）

### 1. CI 都不跑測試 —— realreal 也沒有

realreal 有 39 支測試檔、有 `"test": "vitest run"`、turbo 有 test task，但 `.github/workflows/deploy.yml` 全長 22 行只有 `npm install` + `npx vercel --prod`，**沒有任何測試步驟**。goodday 的 CI 跑了 lint/typecheck/build 卻沒有測試可跑。alice-store 只跑 meta 稽核。

**三個專案沒有任何一個在 merge 前跑過測試。** realreal 那 39 支測試只在有人手動跑時才有價值。這是最便宜的補救，而且該在 alice-store 改造**之前**先做，否則「以 realreal 為標準」會連這個洞一起繼承。

### 2. migration 沒有自動化套用流程，realreal 的還是分裂的

三個專案都是「手寫檔案 + 人工套到 Supabase」，沒有執行紀錄、版本檢查或 CI 驗證。

realreal 更糟：migration 同時存在 `packages/db/migrations/`（46 支）**和** `supabase/migrations/`（3 支），其中 `0034_money_units_twd_and_tier_atomic.sql` 是同一支放兩個地方。

實務後果：`docs/OPEN-BUGS.md` 有「migration 0037 已套用線上」這種手動註記 —— **線上 schema 的真實狀態靠人記**。alice-store 要新增十幾張交易表，這問題會放大。

### 3. 可觀測性靠 `console.*`

realreal 最好但也只是相對：worker 用 pino，route handler 與 webhook 仍是 `console.error`。三個都沒有 request id、沒有結構化欄位、無法把一筆訂單的完整生命週期串起來查。

realreal 至少有 `order_post_payment_log`、`webhook_events`、`order_idempotency_keys` 三張稽核表 —— 但那些都是**事故後才加的**（migration 編號 0028/0032/0033 全在後段）。「客人說付了錢但訂單是 pending」這種問題，三個專案裡只有 realreal 查得出來。

---

## 五、不要抄的東西

- **realreal 的 subscription-billing worker 是地雷**：`apps/api/src/worker.ts:14-19` 自己標了大字警告 —— 它**根本不會真的扣款**，卻會把訂單標 completed 並寄出「已扣款」通知信。
- **realreal 的 Drizzle ORM**：有 `packages/db` + drizzle-kit，但 46 支 migration 全是手寫 SQL、schema 檔只有 5 個，ORM 沒發揮價值。不要為了對齊而導入。
- **goodday 的庫存扣減**（見 A1）。
- **realreal 的多金流併行**（三套 webhook、三種驗簽風格、三份狀態機）—— 已指定只用 PayUni 就維持一套。
- **realreal 無 i18n** 是它落後，不是標準。alice-store 的三語 + CI 強制 meta 稽核比它好，改電商時**不要退化**：商品名稱、規格、訂單狀態文案都要一開始就走三語欄位（goodday 事後補 i18n 花了一整支 migration）。
