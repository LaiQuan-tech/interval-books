/**
 * 自訂 server entry —— 這個專案唯一一條「非 createServerFn」的伺服器路徑。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * 全站的伺服器邏輯都走 createServerFn（src/lib/checkout-fns.ts、src/lib/admin/fns/*），
 * 那是刻意的，不要因為這個檔案存在就開始在這裡加業務邏輯。這裡只有一個理由：
 * PayUni 的背景通知（NotifyURL）是外部系統對一個我們指定的網址送
 * `application/x-www-form-urlencoded` POST。createServerFn 的端點是框架自己的
 * RPC 協定（固定路徑前綴 + 固定序列化格式），金流商沒有辦法照著打。
 *
 * TanStack Start 1.167 沒有 file-based API routes —— @tanstack/react-start 與
 * router-core 都查不到 createServerFileRoute / route `server.handlers`。可用的
 * 掛載點是自訂 server entry：start-plugin-core 的 resolveStartEntryPlan() 會把
 * `src/server.ts` 當成 server entry（見 node_modules/@tanstack/start-plugin-core/
 * dist/esm/planning.js），沒有這個檔案時才退回框架的預設 entry。
 *
 * 所以這裡的規矩是：
 *   * 只攔下面那張表列出的路徑，其他一律原封不動交回 startFetch。
 *   * 每條路徑的實作都用 dynamic import 載入，service_role client 不會在這個模組
 *     載入時就被拉進來。
 *   * 要再加路徑時，先確認它真的不能用 createServerFn 表達。
 *
 * 目前掛在這裡的兩條，理由各自不同：
 *   PAYUNI_WEBHOOK_PATH  外部金流商送 form-urlencoded POST，打不到框架的 RPC 協定。
 *   INVOICE_TASK_PATH    外部排程（Vercel Cron / Railway worker）要有地方定時打，
 *                        用來補開失敗的發票。同樣不是瀏覽器發起的請求。
 */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { PAYUNI_WEBHOOK_PATH } from "@/server/payuni";
import { INVOICE_TASK_PATH } from "@/server/task-endpoints";

const startFetch = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request, ...rest: unknown[]): Promise<Response> {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      pathname = "";
    }

    if (pathname === PAYUNI_WEBHOOK_PATH) {
      const { handlePayuniWebhook } = await import("@/server/payuni-webhook");
      return handlePayuniWebhook(request);
    }

    if (pathname === INVOICE_TASK_PATH) {
      const { handleInvoiceTask } = await import("@/server/task-endpoints");
      return handleInvoiceTask(request);
    }

    return (startFetch as (req: Request, ...a: unknown[]) => Promise<Response>)(request, ...rest);
  },
};
