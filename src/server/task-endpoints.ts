/**
 * POST /api/tasks/invoices —— 補開發票的排程入口。
 *
 * ── 為什麼需要這條路徑 ────────────────────────────────────────────────────
 * 付款成功時 webhook 會就地開一次發票（src/server/payuni-webhook.ts），但那一次可能
 * 失敗：Amego 當下掛掉、逾時、serverless instance 在回應之前被回收。那些單會停在
 * invoices.status='failed'（或過期的 'issuing'），而**沒有任何東西會自己再試一次**。
 *
 * 0006_order_expiry.sql 已經示範過這個坑：`expire_unpaid_orders()` 寫得再好，沒有
 * 排程呼叫它就是一段死碼。所以這條路徑存在的意義只有一個 —— 讓外部排程有地方打。
 *
 * ⚠️ 目前還沒有排程在打它。上線待辦（擇一）：
 *   * Vercel Cron：在 vercel.json 加
 *     `{"crons":[{"path":"/api/tasks/invoices?k=<TASKS_SECRET>","schedule":"*\/10 * * * *"}]}`
 *   * Railway worker（下一階段的規劃）：幾分鐘一次 POST 這條路徑。
 * 在其中之一存在之前，開票失敗的訂單要靠人看 invoice_backlog() 才會被發現。
 *
 * ── 安全性 ────────────────────────────────────────────────────────────────
 * 與 PayUni webhook 同一套：密鑰在 query string（`?k=`），缺密鑰 503、不符 404，
 * 常數時間比對。這條路徑會對外部 API 產生真實副作用（開稅務憑證），所以它比一般的
 * 讀取端點更需要擋住掃描式請求 —— 連 body 都不解析就先擋掉。
 */
import "@tanstack/react-start/server-only";
import { timingSafeEqual } from "node:crypto";

export const INVOICE_TASK_PATH = "/api/tasks/invoices";

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * 跑一輪補開。
 *
 * GET 也接受，因為 Vercel Cron 只會送 GET；副作用性的端點通常不該接 GET，但這裡的
 * 保護是密鑰而不是 HTTP 動詞，而且這個動作本身是冪等的（claim 擋住重複、Amego 的
 * OrderId 唯一性再擋一次），所以差別只在方便性。
 *
 * `?order=<uuid>` 只補開指定的那一張。存在的理由是人工排查：某一張卡住時，要能單獨
 * 重跑它並立刻看到結果，而不是跑一整輪 backlog 再去猜哪一行是它。它同時也是併發
 * 測試的入口 —— 對同一個 order 同時打兩次，正好驗證 claim 真的只放行一個。
 */
export async function handleInvoiceTask(req: Request): Promise<Response> {
  if (req.method !== "POST" && req.method !== "GET") return text("method not allowed", 405);

  const secret = process.env.TASKS_SECRET;
  if (!secret) return text("service unavailable", 503);

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return text("bad request", 400);
  }
  if (!secretMatches(url.searchParams.get("k"), secret)) return text("not found", 404);

  // service_role 的資料層只在通過密鑰閘門後才載入。
  const { reclaimStaleInvoices } = await import("@/server/repos/invoices");
  const { issueInvoiceForOrder, runInvoiceBacklog } = await import("@/server/invoice-issuer");

  const singleOrder = url.searchParams.get("order");
  if (singleOrder) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(singleOrder)) {
      return text("bad order id", 400);
    }
    const outcome = await issueInvoiceForOrder(singleOrder);
    return json({ ok: true, order: singleOrder, outcome });
  }

  // 先把卡在 issuing 的撥回來 —— claim 本身就會接手過期的 claim，這一步是為了讓
  // 那些單在資料庫裡的狀態是誠實的（見 0007 reclaim_stale_invoices 的註解）。
  const reclaimed = await reclaimStaleInvoices(100);
  if (reclaimed.length > 0) {
    console.warn(
      `[tasks] 撿回 ${reclaimed.length} 張卡在 issuing 的發票：${reclaimed.map((r) => r.orderNo).join(", ")}`,
    );
  }

  const result = await runInvoiceBacklog(20);
  return json({ ok: true, reclaimed: reclaimed.length, ...result });
}
