/**
 * POST /api/webhooks/payuni — PayUni NotifyURL 背景通知。
 *
 * ── 這個 handler 為什麼不是 createServerFn ────────────────────────────────
 * 這個專案的 server 端邏輯一律走 createServerFn（見 src/lib/checkout-fns.ts），
 * 但 createServerFn 的端點是框架自己的 RPC 協定（固定路徑前綴、固定序列化格式），
 * 外部金流商沒辦法照著打。PayUni 是對一個「我們指定的網址」送 form-urlencoded
 * POST，所以需要一條真正的 HTTP 路由。
 *
 * TanStack Start 1.167 這個版本沒有 file-based API routes（node_modules 內查無
 * createServerFileRoute / server handlers），可用的掛載點是**自訂 server entry**：
 * start-plugin-core 的 resolveStartEntryPlan() 會自動採用 src/server.ts。
 * 所以 src/server.ts 攔下這條路徑交給這裡，其餘全部原封不動交回框架。
 *
 * ── 安全性（四層，順序不可顛倒）──────────────────────────────────────────
 *   1. 密鑰閘門 —— NotifyURL 建立時就附上 ?k=<PAYUNI_WEBHOOK_SECRET>
 *      （見 src/server/payuni.ts payuniNotifyUrl）。缺密鑰或不符直接 503/404，
 *      連 body 都不解析，擋掉所有偽造／掃描式 POST。
 *   2. 驗簽 —— 自己用 SHA256(HashKey + 收到的 EncryptInfo + HashIV) 重算，與收到的
 *      HashInfo 常數時間比對。⚠️ 不符整包丟棄，絕不進到解密。
 *   3. 去重 —— webhook_events 的 unique(gateway, event_key) 就是鎖。重送的同一個
 *      事件搶不到 insert，直接 ack 不做任何事（不會重複加值、重複開發票）。
 *   4. 金額比對 —— 收到的金額與 orders.total 不符一律不標 paid，記錄並告警。
 *
 * ── ack 格式（尚待憑證實測）──────────────────────────────────────────────
 * 官方文件查不到「要回什麼給 PayUni 才算收到」。目前一律回 HTTP 200 純文字 "OK"。
 * 若實測發現 PayUni 持續重送，請改成官方要求的字面值。在確認之前重送是安全的 ——
 * 第 3 層去重就是為此存在。
 */
import "@tanstack/react-start/server-only";
import { timingSafeEqual } from "node:crypto";
import {
  decryptInfo,
  verifyHashInfo,
  TRADE_STATUS_PAID,
  TRADE_STATUS_FAILED,
  TRADE_STATUS_CANCELLED,
} from "@/server/payuni";

/** 常數時間比對，避免以回應時間逐字元還原密鑰。 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * 是否用伺服器對伺服器反查當作權威來源。
 *
 * 預設 false。TRADE_QUERY_VERSION 是沒有憑證驗證過的猜測值，把它接成 fail-closed
 * 的必經之路、猜錯的後果是「所有付款都推不進訂單狀態、客人付了錢訂單卻卡住」。
 * 拿到沙盒憑證、確認查詢 API 回得出東西之後，設 PAYUNI_VERIFY_BY_QUERY=true 打開。
 */
function verifyByQuery(): boolean {
  return process.env.PAYUNI_VERIFY_BY_QUERY === "true";
}

export async function handlePayuniWebhook(req: Request): Promise<Response> {
  if (req.method !== "POST") return text("method not allowed", 405);

  // ---------- 第 1 層：密鑰閘門（在任何 body 解析或資料庫存取之前） ----------
  const webhookSecret = process.env.PAYUNI_WEBHOOK_SECRET;
  if (!webhookSecret) return text("service unavailable", 503);

  let k: string | null;
  try {
    k = new URL(req.url).searchParams.get("k");
  } catch {
    return text("bad request", 400);
  }
  if (!secretMatches(k, webhookSecret)) return text("not found", 404);

  // PayUni 以 form-urlencoded POST;少數情況可能是 JSON,兩種都吃。
  let body: Record<string, string>;
  try {
    const raw = await req.text();
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      body = JSON.parse(raw) as Record<string, string>;
    } else {
      body = {};
      for (const [key, value] of new URLSearchParams(raw)) body[key] = value;
    }
  } catch {
    return text("bad request", 400);
  }

  const encryptInfoHex = body.EncryptInfo;
  const receivedHash = body.HashInfo;
  if (!encryptInfoHex || !receivedHash) return text("missing EncryptInfo/HashInfo", 400);

  // ---------- 第 2 層：先驗簽,不符整包丟棄(絕不進到解密) ----------
  if (!verifyHashInfo(encryptInfoHex, receivedHash)) {
    console.error("[payuni] HashInfo 驗簽失敗,整包丟棄");
    return text("invalid signature", 400);
  }

  let notify: Record<string, string>;
  try {
    notify = decryptInfo(encryptInfoHex);
  } catch (err) {
    console.error("[payuni] decryptInfo failed:", err);
    return text("decrypt failed", 400);
  }

  const orderNo = notify.MerTradeNo;
  if (!orderNo) return text("missing MerTradeNo", 400);

  // service_role 的資料層只在驗簽通過後才載入。
  const {
    annotateWebhookEvent,
    claimWebhookEvent,
    eventKeyFor,
    findOrderByOrderNo,
    markOrderPaid,
    markPaymentFailed,
    releaseWebhookClaim,
  } = await import("@/server/repos/payments");

  const order = await findOrderByOrderNo(orderNo);
  if (!order) {
    // 找不到對應訂單(測試通知、MerTradeNo 打錯,或密鑰外洩後的偽造值):直接 ack。
    // 不往上游反查 —— 避免把反查端點當成可被利用的放大攻擊入口。
    console.warn(`[payuni] 找不到訂單 order_no=${orderNo},忽略`);
    return text("OK");
  }

  // ---------- 第 3 層:去重。claim 拿不到就是重送 ----------
  const eventKey = eventKeyFor(notify);
  const claim = await claimWebhookEvent(eventKey, { notify, receivedAt: new Date().toISOString() });
  if (claim === "duplicate") {
    console.info(`[payuni] 重複通知已忽略 event_key=${eventKey}`);
    return text("OK (duplicate)");
  }
  if (claim === "error") {
    // 拿不準是不是重複 → 逼上游重送,不要在不確定的情況下動訂單。
    return text("claim failed; please retry", 500);
  }

  /** claim 之後任何「重試有機會成功」的失敗,都要把 claim 還回去。 */
  const retryable = async (reason: string): Promise<Response> => {
    await releaseWebhookClaim(eventKey);
    return text(reason, 500);
  };

  // ---------- 權威來源 ----------
  // 預設用通知內容(已通過驗簽 + AES-GCM 完整性保護)。開啟 PAYUNI_VERIFY_BY_QUERY
  // 後改用伺服器對伺服器反查,連「持有金鑰者送出的舊資料」都不信。
  let tradeStatus: string | undefined = notify.TradeStatus;
  let tradeAmtRaw: string | undefined = notify.TradeAmt ?? notify.Amount;
  let tradeNo: string | undefined = notify.TradeNo;
  let dataSource: string | undefined = notify.DataSource;
  let authoritative: Record<string, unknown> = notify;

  if (verifyByQuery()) {
    try {
      const { queryPayuniTrade } = await import("@/server/payuni");
      const q = await queryPayuniTrade(orderNo);
      tradeStatus = q.tradeStatus;
      tradeAmtRaw = q.tradeAmt === undefined ? undefined : String(q.tradeAmt);
      tradeNo = q.tradeNo ?? tradeNo;
      dataSource = q.dataSource;
      authoritative = { notify, query: q.raw };
    } catch (err) {
      console.error("[payuni] queryPayuniTrade failed:", err);
      // fail-closed:反查失敗就逼 PayUni 重送,不能靜默 ack 放過
      // (否則真正完成的付款會卡在 pending 永遠沒人知道)。
      return retryable("query failed; please retry");
    }
  }

  const isPaid = tradeStatus === TRADE_STATUS_PAID;
  // DataSource="B" 代表上游還在處理、資料不完整,此時不把訂單判成失敗。
  const isFailed =
    dataSource !== "B" &&
    (tradeStatus === TRADE_STATUS_FAILED || tradeStatus === TRADE_STATUS_CANCELLED);

  if (isPaid) {
    const collected = Number(tradeAmtRaw);
    if (!Number.isFinite(collected)) {
      console.error(
        `[payuni] order=${orderNo} TradeStatus=1 但沒有可用的金額欄位 — 不標 paid,待人工對帳`,
      );
      await annotateWebhookEvent(eventKey, { notify, refused: "missing_amount" });
      return text("missing amount", 409);
    }

    // ---------- 第 4 層:金額比對 ----------
    const expected = Math.round(Number(order.total));
    if (Math.round(collected) !== expected) {
      console.error(
        `[payuni] AMOUNT MISMATCH order=${orderNo} collected=${Math.round(collected)} expected=${expected} — 拒絕標記 paid,需人工對帳`,
      );
      // claim 刻意保留:金額不符不是重試能解決的,重送只會重複告警。
      await annotateWebhookEvent(eventKey, {
        notify,
        refused: "amount_mismatch",
        collected: Math.round(collected),
        expected,
      });
      return text("amount mismatch", 409);
    }

    const result = await markOrderPaid(order, {
      tradeNo,
      amount: expected,
      raw: authoritative,
    });
    if (!result.ok && result.reason === "db_error") {
      return retryable("order update failed; please retry");
    }
    if (!result.ok) {
      // paid_after_cancel / stale:已經在 repo 裡告警過了。回 200,重送也不會變好。
      await annotateWebhookEvent(eventKey, { notify, refused: result.reason });
      return text(`OK (${result.reason})`);
    }
    return text("OK");
  }

  if (isFailed) {
    const outcome = await markPaymentFailed(order, {
      reason: `payuni_trade_status_${tradeStatus ?? "unknown"}`,
      raw: authoritative,
    });
    if (outcome === "db_error") return retryable("order update failed; please retry");
    return text("OK");
  }

  // TradeStatus="0"(取號成功)/"8"(訂單待確認)或 DataSource="B"(處理中):
  // 不做任何動作,單純 ack,等後續通知。event_key 含 TradeStatus,所以之後那則
  // 「付款成功」的通知會是不同的 key,不會被這一則的 claim 擋掉。
  return text("OK");
}
