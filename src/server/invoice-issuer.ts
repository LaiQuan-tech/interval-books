/**
 * 開發票的編排層：claim → 打 Amego → 記結果。
 *
 * ── 為什麼 claim 一定要在打 Amego 之前 ──────────────────────────────────────
 * 發票開出去撤不回來。財政部那邊多一張就是多一張，只能再開一張作廢單去沖銷，而客人
 * 的信箱裡已經躺著兩份稅務憑證了。所以順序是硬性的：
 *
 *   1. claimInvoiceIssue()  —— 原子地宣告「這張由我開」（0007 的三道閘門）
 *   2. 呼叫 Amego           —— 只有拿到 claim 的人可以做這一步
 *   3. finish / fail        —— 一定要走到其中一個
 *
 * 反過來（先開再記）在任何一次重送、任何一次 instance 被回收時都會開出第二張。
 *
 * ── 重試前先問「是不是已經開過了」────────────────────────────────────────
 * 第 2 步與第 3 步之間如果程序被砍掉，狀態是「Amego 已經開了，我們沒記到」。這一種
 * 一定要用 findInvoiceByOrderId() 認回來，而不是重開一張。Amego 的 OrderId 唯一，
 * 所以我們用 orders.order_no 當 OrderId，它天然就是冪等鍵；就算沒查、直接重開，
 * Amego 也會回 3040171（OrderId 重複），那同樣被當成「已經開過」處理 —— 兩道保險。
 *
 * ── 為什麼失敗不會讓 webhook 失敗 ──────────────────────────────────────────
 * docs/alignment-audit.md 已經寫過：把開發票塞進金流 webhook 的同步流程，Amego 一掛
 * 就會讓 PayUni 收到 5xx 而不斷重送。所以 issueInvoiceForOrder() 從不 throw，
 * 呼叫端（webhook）拿到的永遠是一個可以忽略的結果物件，而失敗會留在 invoices 與
 * order_post_payment_log 裡等 backlog 收拾。
 */
import "@tanstack/react-start/server-only";
import {
  AMEGO_CODE_DUPLICATE_ORDER,
  amegoConfigured,
  findInvoiceByOrderId,
  isPermanentAmegoError,
  isValidTaxId,
  issueInvoice,
  type InvoiceLine,
} from "@/server/amego";
import {
  claimInvoiceIssue,
  failInvoiceIssue,
  finishInvoiceIssue,
  getInvoicePrefs,
  getOrderForInvoice,
  invoiceBacklog,
} from "@/server/repos/invoices";

export type IssueOutcome =
  | { ok: true; invoiceNumber: string; adopted: boolean }
  | { ok: false; reason: string; permanent: boolean };

/** 發票品名的長度上限。超過 Amego 會擋，截斷比開不出來好。 */
const MAX_DESCRIPTION = 100;

/**
 * 把一張訂單攤成發票明細。
 *
 * 三條規則，每一條都有理由：
 *   * 運費是一列 —— 併進商品單價會讓明細對不上客人手上的訂單，國稅局查帳時也對不起來。
 *   * 折扣是**負數列**，不是另外的欄位。官方範例就是這樣做的
 *     （{"Description":"會員折抵","UnitPrice":"-2","Amount":"-2"}）。
 *   * 品名取中文 —— 發票是給國稅局看的，不跟著客人的介面語言走。
 *
 * 明細加總必須等於 orders.total，呼叫端會斷言這件事。
 */
export function buildInvoiceLines(
  order: { shippingFee: number; discount: number },
  items: { name: Record<string, string>; unitPrice: number; quantity: number; subtotal: number }[],
): InvoiceLine[] {
  const lines: InvoiceLine[] = items.map((item) => ({
    description: (item.name.zh || item.name.en || item.name.ja || "商品").slice(0, MAX_DESCRIPTION),
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    amount: item.subtotal,
  }));

  if (order.shippingFee > 0) {
    lines.push({
      description: "運費",
      quantity: 1,
      unitPrice: order.shippingFee,
      amount: order.shippingFee,
    });
  }
  if (order.discount > 0) {
    lines.push({
      description: "折扣",
      quantity: 1,
      unitPrice: -order.discount,
      amount: -order.discount,
    });
  }

  return lines;
}

/** 明細加總。與 orders.total 比對用。 */
export function sumInvoiceLines(lines: InvoiceLine[]): number {
  return lines.reduce((acc, l) => acc + l.amount, 0);
}

/**
 * 決定這張發票的買方資訊。
 *
 * 統編格式不對時**退回 B2C 開立**而不是失敗：一張抬頭不完美的發票，永遠好過一張
 * 因為客人打錯統編就永遠開不出來的發票（那個失敗是永久性的，只能人工介入）。
 * 客人要改抬頭可以走折讓／作廢重開，那是有補救路徑的；沒有發票沒有補救路徑。
 */
export function resolveBuyer(
  prefs: {
    invoiceType: string;
    taxId: string | null;
    companyTitle: string | null;
    carrierType: string | null;
    carrierNumber: string | null;
    loveCode: string | null;
  } | null,
  order: { customerName: string; customerEmail: string },
): {
  taxId: string | null;
  buyerName: string;
  carrierType: string | null;
  carrierId: string | null;
  loveCode: string | null;
  warning: string | null;
} {
  const wantsCompany = prefs?.invoiceType === "company";
  const rawTaxId = (prefs?.taxId ?? "").trim();

  if (wantsCompany && rawTaxId) {
    if (isValidTaxId(rawTaxId)) {
      return {
        taxId: rawTaxId,
        buyerName: (prefs?.companyTitle ?? "").trim() || order.customerName || "消費者",
        carrierType: null,
        carrierId: null,
        loveCode: null,
        warning: null,
      };
    }
    return {
      taxId: null,
      buyerName: order.customerName || "消費者",
      carrierType: null,
      carrierId: null,
      loveCode: null,
      warning: `統編 ${rawTaxId} 檢核碼不正確，已改開個人發票`,
    };
  }

  if (prefs?.invoiceType === "donate" && (prefs.loveCode ?? "").trim()) {
    return {
      taxId: null,
      buyerName: order.customerName || "消費者",
      carrierType: null,
      carrierId: null,
      loveCode: (prefs.loveCode ?? "").trim(),
      warning: null,
    };
  }

  return {
    taxId: null,
    buyerName: order.customerName || "消費者",
    carrierType: (prefs?.carrierType ?? "").trim() || null,
    carrierId: (prefs?.carrierNumber ?? "").trim() || null,
    loveCode: null,
    warning: null,
  };
}

/**
 * 開一張訂單的發票。永不 throw。
 *
 * 回傳 ok:false 時 reason 已經寫進資料庫（invoices.error_message 與
 * order_post_payment_log.error_message），所以呼叫端不需要另外記；它只需要決定要不要
 * 因此改變自己的回應（webhook 的答案是「不要」）。
 */
export async function issueInvoiceForOrder(orderId: string): Promise<IssueOutcome> {
  if (!amegoConfigured()) {
    // 刻意不 claim：沒有設定不是這張訂單的問題，claim 下去只會把 retry_count 燒掉，
    // 讓設定補上之後反而開不出來。留在 backlog 裡等設定到位。
    console.warn(
      `[amego] 未設定 AMEGO_INVOICE_BAN / AMEGO_APP_KEY，訂單 ${orderId} 的發票留待補開`,
    );
    return { ok: false, reason: "amego_not_configured", permanent: false };
  }

  const claim = await claimInvoiceIssue(orderId);
  if (!claim.claimed) {
    if (claim.reason === "already_issued") {
      return { ok: true, invoiceNumber: claim.invoiceNumber ?? "", adopted: true };
    }
    // locked 是正常的併發結果，不值得吵；其餘都值得留紀錄。
    if (claim.reason !== "locked") {
      console.warn(`[amego] 未取得開票許可 order=${orderId} reason=${claim.reason}`);
    }
    return { ok: false, reason: claim.reason, permanent: claim.reason === "retries_exhausted" };
  }

  // 拿到 claim 之後，任何路徑都必須走到 finish 或 fail。
  try {
    return await issueWithClaim(orderId, claim.attempt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[amego] 開票途中發生未預期例外 order=${orderId}`, err);
    await failInvoiceIssue({ orderId, error: `unexpected: ${message}`, permanent: false });
    return { ok: false, reason: "unexpected_error", permanent: false };
  }
}

async function issueWithClaim(orderId: string, attempt: number): Promise<IssueOutcome> {
  const loaded = await getOrderForInvoice(orderId);
  if (!loaded) {
    await failInvoiceIssue({ orderId, error: "order_not_found", permanent: true });
    return { ok: false, reason: "order_not_found", permanent: true };
  }
  const { order, items } = loaded;

  if (items.length === 0) {
    await failInvoiceIssue({ orderId, error: "order_has_no_items", permanent: true });
    return { ok: false, reason: "order_has_no_items", permanent: true };
  }

  // ---- 重試前先問 Amego：上一次是不是其實開成功了 ----------------------------
  // attempt > 0 才問，第一次開票不需要多這一次往返。
  if (attempt > 0) {
    const found = await findInvoiceByOrderId(order.orderNo);
    if (found.ok && found.hit && found.hit.invoiceNumber) {
      console.warn(
        `[amego] order=${order.orderNo} 上一次其實已經開成功（${found.hit.invoiceNumber}），認回來不重開`,
      );
      await finishInvoiceIssue({
        orderId,
        invoiceNumber: found.hit.invoiceNumber,
        randomCode: found.hit.randomNumber || null,
      });
      return { ok: true, invoiceNumber: found.hit.invoiceNumber, adopted: true };
    }
    // 查詢失敗不阻斷：真的重複開了，Amego 會用 3040171 擋下來，下面有處理。
    if (!found.ok) {
      console.warn(
        `[amego] order=${order.orderNo} 重試前查詢失敗（${found.msg}），改靠 OrderId 唯一性`,
      );
    }
  }

  const lines = buildInvoiceLines(order, items);
  const linesTotal = sumInvoiceLines(lines);

  // ---- 金額必須與訂單一致，否則不開 ------------------------------------------
  // 發票是稅務憑證：開一張金額跟訂單不符的，比不開更難收拾（要作廢重開，而且已經
  // 上傳到財政部）。這是永久失敗，等人查清楚為什麼對不起來。
  if (linesTotal !== order.total) {
    const msg = `amount_mismatch lines=${linesTotal} order_total=${order.total}`;
    console.error(`[amego] 🚨 ${msg} order=${order.orderNo} — 拒絕開立，需人工確認`);
    await failInvoiceIssue({ orderId, error: msg, permanent: true });
    return { ok: false, reason: "amount_mismatch", permanent: true };
  }

  const prefs = await getInvoicePrefs(orderId);
  const buyer = resolveBuyer(prefs, order);
  if (buyer.warning) console.warn(`[amego] order=${order.orderNo} ${buyer.warning}`);

  const result = await issueInvoice({
    orderId: order.orderNo,
    taxId: buyer.taxId,
    buyerName: buyer.buyerName,
    buyerEmail: order.customerEmail || null,
    carrierType: buyer.carrierType,
    carrierId: buyer.carrierId,
    loveCode: buyer.loveCode,
    lines,
  });

  if (result.ok && result.invoice?.invoiceNumber) {
    const finished = await finishInvoiceIssue({
      orderId,
      invoiceNumber: result.invoice.invoiceNumber,
      randomCode: result.invoice.randomNumber || null,
      issuedAt: result.invoice.invoiceTime
        ? new Date(result.invoice.invoiceTime * 1000).toISOString()
        : undefined,
    });
    if (!finished.ok) {
      // 發票真的開出去了，只是我們沒記成功。絕不可以標成 failed 讓它被重開。
      console.error(
        `[amego] 🚨 已開立但寫回資料庫失敗 order=${order.orderNo} invoice=${result.invoice.invoiceNumber} — ` +
          `不重試，需人工把號碼補進 invoices`,
      );
      return { ok: false, reason: "issued_but_not_recorded", permanent: true };
    }
    console.info(
      `[amego] 已開立 order=${order.orderNo} invoice=${result.invoice.invoiceNumber} total=${order.total}`,
    );
    return { ok: true, invoiceNumber: result.invoice.invoiceNumber, adopted: false };
  }

  // ---- 開立成功以外的每一種回應 ----------------------------------------------
  if (result.ok) {
    // code=0 但沒有發票號碼。不該發生；當成失敗，而不是當成成功放它過去。
    await failInvoiceIssue({ orderId, error: "ok_without_invoice_number", permanent: false });
    return { ok: false, reason: "ok_without_invoice_number", permanent: false };
  }

  // OrderId 重複 = 這張訂單已經開過了。查回來認領，而不是報錯，也絕不重開。
  if (result.kind === "business" && result.code === AMEGO_CODE_DUPLICATE_ORDER) {
    const found = await findInvoiceByOrderId(order.orderNo);
    if (found.ok && found.hit?.invoiceNumber) {
      console.warn(
        `[amego] order=${order.orderNo} OrderId 重複，認回既有發票 ${found.hit.invoiceNumber}`,
      );
      await finishInvoiceIssue({
        orderId,
        invoiceNumber: found.hit.invoiceNumber,
        randomCode: found.hit.randomNumber || null,
      });
      return { ok: true, invoiceNumber: found.hit.invoiceNumber, adopted: true };
    }
    await failInvoiceIssue({
      orderId,
      error: "duplicate_order_id_but_query_failed",
      permanent: false,
    });
    return { ok: false, reason: "duplicate_order_id_but_query_failed", permanent: false };
  }

  const code = result.kind === "business" ? result.code : null;
  const permanent = isPermanentAmegoError(code);
  const message = `amego code=${code ?? "transport"} msg=${result.msg}`;
  console.error(`[amego] 開立失敗 order=${order.orderNo} ${message} permanent=${permanent}`);
  await failInvoiceIssue({ orderId, error: message, permanent });
  return { ok: false, reason: message, permanent };
}

/**
 * 付款確認之後觸發開票，且**保證不會拖垮呼叫端**。
 *
 * webhook 的職責是「盡快告訴金流商我收到了」。Amego 慢一點沒關係（實測單次往返約
 * 200ms），但它掛掉時不能讓 PayUni 收到逾時或 5xx —— 那會換來無止盡的重送。所以這裡
 * 給一個上限，超時就當作沒開成，交給 backlog；claim 會在 p_stale_after 之後被接手。
 */
export async function triggerInvoiceAfterPayment(
  orderId: string,
  timeoutMs = 8_000,
): Promise<IssueOutcome> {
  const timeout = new Promise<IssueOutcome>((resolve) =>
    setTimeout(
      () => resolve({ ok: false, reason: "invoice_timeout", permanent: false }),
      timeoutMs,
    ).unref?.(),
  );
  try {
    const outcome = await Promise.race([issueInvoiceForOrder(orderId), timeout]);
    if (!outcome.ok && outcome.reason === "invoice_timeout") {
      console.error(`[amego] 開票逾時 order=${orderId} —— 已交給 backlog，webhook 照常回 200`);
    }
    return outcome;
  } catch (err) {
    console.error("[amego] triggerInvoiceAfterPayment 例外", err);
    return { ok: false, reason: "unexpected_error", permanent: false };
  }
}

export type BacklogRunResult = {
  scanned: number;
  issued: number;
  adopted: number;
  failed: number;
  details: { orderNo: string; outcome: string }[];
};

/**
 * 掃過待開清單，逐張補開。
 *
 * 這是「開立失敗不會就這樣算了」的那一半 —— webhook 當下失敗的、instance 被回收的、
 * Amego 當時掛掉的，全部從這裡補回來。目前由 /api/tasks/invoices 觸發
 * （src/server/task-endpoints.ts），排程還沒接（見那個檔案的 ⚠️）。
 *
 * 序列跑，不並行：同時打 Amego 好幾張並沒有比較快（瓶頸不在我們這邊），但併發會讓
 * 錯誤變得難以歸因，而這是一個「錯了就要人工去國稅局收拾」的流程。
 */
export async function runInvoiceBacklog(limit = 20): Promise<BacklogRunResult> {
  const rows = await invoiceBacklog(limit);
  const out: BacklogRunResult = {
    scanned: rows.length,
    issued: 0,
    adopted: 0,
    failed: 0,
    details: [],
  };

  for (const row of rows) {
    const outcome = await issueInvoiceForOrder(row.orderId);
    if (outcome.ok) {
      if (outcome.adopted) out.adopted += 1;
      else out.issued += 1;
      out.details.push({ orderNo: row.orderNo, outcome: `ok ${outcome.invoiceNumber}` });
    } else {
      out.failed += 1;
      out.details.push({ orderNo: row.orderNo, outcome: `fail ${outcome.reason}` });
    }
  }

  return out;
}
