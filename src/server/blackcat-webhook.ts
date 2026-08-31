/**
 * 黑貓 PAY（統一客樂得 COCS）的兩條外部入口：
 *
 *   POST /api/webhooks/blackcat          APN 主動通知（伺服器對伺服器）
 *   GET  /api/payments/blackcat/return   瀏覽器導回（授權完成／授權失敗）
 *
 * ── 為什麼這兩條不是 createServerFn ──────────────────────────────────────
 * 與 payuni-webhook.ts 檔頭同一個理由，而且這裡有兩個獨立的實例：
 *   APN  是金流商的伺服器對我們指定的網址送 application/json POST。
 *   導回 是**客人的瀏覽器**被 302 到我們的網址，帶一串 query string。
 * createServerFn 的端點是框架自己的 RPC 協定（固定路徑前綴 + 固定序列化格式），
 * 這兩種呼叫者都照不出來。掛載點是自訂 server entry（src/server.ts）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * APN 的四層防護 —— 順序不可顛倒
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   ① 密鑰閘門 —— apn_url 建立時就附上 ?k=<BLACKCAT_WEBHOOK_SECRET>
 *      （見 src/server/blackcat.ts blackcatApnUrl）。缺密鑰或不符直接 503/404，
 *      **連 body 都不解析**，擋掉所有偽造／掃描式 POST。
 *
 *   ② 回查黑貓伺服器 —— 🔴 **這一層取代了 PayUni 的「重算簽章」，因為黑貓的
 *      APN 根本沒有可以重算的簽章。** 通知裡的 checksum 是
 *          MD5(api_id : trans_id : amount : status : nonce)
 *      五個欄位**全部都在通知本體裡**，算式裡沒有 hash_base、沒有任何預先共享的
 *      密鑰（規格 V1.28.2 P89）。也就是說任何人都能自己編一份「付款成功」的 JSON
 *      並算出一個合法的 checksum。所以：
 *
 *          checksum 通過 ≠ 這則通知是真的
 *          checksum 通過 ≠ 可以標記付款
 *
 *      能拿來標記付款的**只有** CocsOrderQuery 回來的 process_code（規格 P55）。
 *      回查失敗一律 fail-closed 回 500 逼對方重送，絕不靜默 ack ——
 *      靜默 ack 的意思是「真的付款了但我們永遠不知道」。
 *
 *   ③ 去重 —— webhook_events 的 unique(gateway, event_key) 就是鎖。重送的同一個
 *      事件搶不到 insert，直接 ack 不做任何事（不會重複扣庫存、重複開發票、重複寄信）。
 *
 *   ④ 金額比對 —— 🔴 **用 payment_detail.pay_amount，不是 amount。**
 *      amount 是繳款單金額（就是我們自己送出去的那個數字），pay_amount 才是實際
 *      授權金額。而 checksum 算的是 amount —— 所以「checksum 通過」連「客人付對了
 *      錢」都不證明。規格 P35 注意事項 2 是紅字要求。
 *      ⚠️ 讀不到 pay_amount 時**拒絕標記付款**，不是退而求其次拿別的欄位充數。
 *         見 blackcat.ts apnPaidAmount() 的註解：那個 fallback 會讓比對恆真。
 *
 * ── 付款之後的三件事（順序有意義，不要重排）──────────────────────────
 *   1. commitInventoryForOrder()      貨 —— 庫存保留轉成真正的銷售（0011）
 *   2. triggerInvoiceAfterPayment()   憑證 —— 電子發票（0007）
 *   3. triggerNotifyAfterPayment()    信 —— 付款成功與報名成功通知（0022）
 *
 * 判準是「失敗的可補救程度」，最不可補救的先做。理由與 payuni-webhook.ts 一字不差，
 * 那裡寫得比較長，要改順序之前先去讀那一段。
 *
 * ── ack 格式：純文字 OK，而且是規格明文要求 ────────────────────────────
 * 規格 P87：「繳款完成後 APN 傳送端會即時傳送一次通知；之後每 15 分鐘傳送一次，
 * 一個狀態碼最多傳送 3 次；**若用戶端有回覆純文字「OK」訊息，則就不會再發送**。」
 *
 * 所以**業務面**的拒絕（金額不符、找不到訂單、狀態還不觸發）一律回 200 "OK"：
 * 那些重送不會變好，重送只會把同一則告警再記三次。只有**我們自己壞了**
 * （資料庫失敗、回查失敗）才回 5xx —— 那才是重送真的有機會救回來的情況。
 */
import "@tanstack/react-start/server-only";
import { timingSafeEqual } from "node:crypto";
import {
  AUTHORIZED_PROCESS_CODES,
  APN_TERMINAL_FAILURES,
  FAILED_PROCESS_CODES,
  apnChecksumMatches,
  apnPaidAmount,
  blackcatConfigured,
  toInt,
  verifyReturnChk,
} from "@/server/blackcat";

/** 這個模組寫進 payments / webhook_events 時用的 gateway 值。 */
const GATEWAY = "blackcat";

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

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store" },
  });
}

/**
 * 回查的注入點。
 *
 * 產線一律是 blackcat.ts 的 queryCocsOrder；scripts/blackcat-selftest.mjs 會換掉它，
 * 才能在**不碰真實 gateway** 的前提下驗「handler 一定會回查」與「只信回查結果、
 * 不信通知內容」。刻意做成模組層級的 setter 而不是參數，是為了讓產線的呼叫路徑
 * 上沒有任何「可以繞過回查」的分支 —— handler 本身沒有第二條路可走。
 */
type QueryFn = typeof import("@/server/blackcat").queryCocsOrder;
let queryOverride: QueryFn | null = null;

/** 僅供自檢使用。傳 null 還原成產線那一份。 */
export function __setQueryCocsOrderForTests(fn: QueryFn | null): void {
  queryOverride = fn;
}

async function queryAuthoritative(orderNo: string) {
  if (queryOverride) return queryOverride(orderNo);
  const { queryCocsOrder } = await import("@/server/blackcat");
  return queryCocsOrder(orderNo);
}

// ═══════════════════════════════════════════════════════════════════════════
// APN 主動通知
// ═══════════════════════════════════════════════════════════════════════════

export async function handleBlackcatApn(req: Request): Promise<Response> {
  if (req.method !== "POST") return text("method not allowed", 405);

  // ---------- 第 ① 層：密鑰閘門（在任何 body 解析或資料庫存取之前） ----------
  const webhookSecret = process.env.BLACKCAT_WEBHOOK_SECRET;
  if (!webhookSecret) return text("service unavailable", 503);

  let k: string | null;
  try {
    k = new URL(req.url).searchParams.get("k");
  } catch {
    return text("bad request", 400);
  }
  if (!secretMatches(k, webhookSecret)) return text("not found", 404);

  // 規格 P87：ContentType = application/json。仍然容忍 form-urlencoded，
  // 因為送過來的是別人的實作，而多吃一種格式的成本是零。
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      body = {};
      for (const [key, value] of new URLSearchParams(raw)) body[key] = value;
    } else {
      body = JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
    return text("bad request", 400);
  }

  const orderNo = String(body.order_no ?? "").trim();
  if (!orderNo) return text("missing order_no", 400);

  // ---------- 完整性預篩（**不是**身分驗證）----------
  // 這一步只證明「這則通知的五個欄位彼此一致」，因為算式裡沒有任何祕密。
  // 它擋掉的是隨機亂打的雜訊，不是有心的偽造 —— 真正的判準在第 ② 層。
  // 所以它不夠格當「第 ② 層」，也絕不可以被當成標記付款的依據。
  if (
    !apnChecksumMatches({
      apiId: body.api_id,
      transId: body.trans_id,
      amount: body.amount,
      status: body.status,
      nonce: body.nonce,
      checksum: body.checksum,
    })
  ) {
    console.error(`[blackcat] APN checksum 不符 order=${orderNo}，整包丟棄`);
    return text("invalid checksum", 400);
  }

  // service_role 的資料層只在通過閘門之後才載入。
  const {
    annotateWebhookEvent,
    claimWebhookEvent,
    eventKeyForBlackcat,
    findOrderByOrderNo,
    markOrderPaid,
    markPaymentFailed,
    releaseWebhookClaim,
  } = await import("@/server/repos/payments");

  const order = await findOrderByOrderNo(orderNo);
  if (!order) {
    // 找不到對應訂單（測試通知、打錯、或密鑰外洩後的偽造值）：直接 ack。
    // ⚠️ **刻意不往上游回查。** 回查是要花錢也要花時間的外呼，讓一個未經認證的
    //    POST 就能觸發它，等於把我們的伺服器變成打黑貓的放大器。
    console.warn(`[blackcat] 找不到訂單 order_no=${orderNo}，忽略`);
    return text("OK");
  }

  // ---------- 第 ② 層：回查黑貓伺服器（唯一的權威來源）----------
  // ⚠️ 這一層在去重**之前**。理由是「未經認證的內容絕不可以先動資料庫」：
  //    先 claim 再回查的話，一則偽造的通知會先在 webhook_events 佔走一個
  //    event_key，之後那則**真的**通知就會被自己的去重鎖擋成重複而靜默丟掉。
  //    先回查、確定了再 claim，就沒有這個縫。
  if (!blackcatConfigured()) {
    // 收得到通知卻沒有憑證可以回查 —— 沒有任何安全的推進方式。
    console.error(`[blackcat] order=${orderNo} 收到 APN 但缺少憑證，無法回查`);
    return text("not configured; please retry", 503);
  }

  const q = await queryAuthoritative(orderNo);
  if (!q.ok) {
    // fail-closed：回查失敗就逼對方重送，不能靜默 ack 放過
    //（否則真正完成的付款會卡在 pending，永遠沒有人知道）。
    // 此時還沒有 claim，所以沒有東西要還。
    console.error(`[blackcat] order=${orderNo} 回查失敗：${q.reason}`);
    return text("query failed; please retry", 500);
  }

  const processCode = q.result.processCode;
  const authorized = processCode !== null && AUTHORIZED_PROCESS_CODES.has(processCode);
  // 失敗的判定要**回查與通知都同意**才算數：回查說這筆沒了（16/6/5/17/27），
  // 或通知帶的是終局失敗狀態碼而回查也不在授權區間。
  const failed =
    !authorized &&
    ((processCode !== null && FAILED_PROCESS_CODES.has(processCode)) ||
      APN_TERMINAL_FAILURES.has(String(body.status ?? "")));

  // ---------- 第 ③ 層：去重。claim 拿不到就是重送 ----------
  const eventKey = eventKeyForBlackcat(body);
  const claim = await claimWebhookEvent(
    eventKey,
    { apn: body, query: q.result.raw, receivedAt: new Date().toISOString() },
    GATEWAY,
  );
  if (claim === "duplicate") {
    console.info(`[blackcat] 重複通知已忽略 event_key=${eventKey}`);
    return text("OK");
  }
  if (claim === "error") {
    // ⚠️ 拿不準是不是重複 → 逼上游重送，不要在不確定的情況下動訂單。
    //    快樂手那一版把「資料庫錯誤」與「唯一鍵衝突」壓成同一個回傳值，於是
    //    資料庫抖動一秒就等於那則通知被當成重複、靜默 ack、永遠不再處理。
    return text("claim failed; please retry", 500);
  }

  /** claim 之後任何「重試有機會成功」的失敗，都要把 claim 還回去。 */
  const retryable = async (reason: string): Promise<Response> => {
    await releaseWebhookClaim(eventKey, GATEWAY);
    return text(reason, 500);
  };

  if (authorized) {
    // ---------- 第 ④ 層：金額比對，用 pay_amount ----------
    const collected = apnPaidAmount(body);
    if (collected === null) {
      // 🔴 這裡**不可以**退而求其次拿 amount 或回查的 order_amount 來充數：
      //    那兩個都等於我們自己送出去的訂單金額，比對會變成 total === total 恆真。
      //    黑貓說授權完成卻沒給授權金額，是需要人看的異常，不是可以猜過去的空值。
      console.error(
        `[blackcat] order=${orderNo} process_code=${processCode} 授權完成但通知沒有 pay_amount — 不標 paid，待人工對帳`,
      );
      await annotateWebhookEvent(
        eventKey,
        { apn: body, query: q.result.raw, refused: "missing_pay_amount" },
        GATEWAY,
      );
      return text("OK (missing pay_amount)");
    }

    const expected = Math.round(Number(order.total));
    if (collected !== expected) {
      console.error(
        `[blackcat] AMOUNT MISMATCH order=${orderNo} collected=${collected} expected=${expected} — 拒絕標記 paid，需人工對帳`,
      );
      // claim 刻意保留：金額不符不是重試能解決的，重送只會重複告警。
      await annotateWebhookEvent(
        eventKey,
        {
          apn: body,
          query: q.result.raw,
          refused: "amount_mismatch",
          collected,
          expected,
        },
        GATEWAY,
      );
      return text("OK (amount mismatch)");
    }

    const result = await markOrderPaid(order, {
      tradeNo: String(body.trans_id ?? "") || undefined,
      amount: expected,
      raw: { apn: body, query: q.result.raw },
      gateway: GATEWAY,
    });
    if (!result.ok && result.reason === "db_error") {
      return retryable("order update failed; please retry");
    }
    if (!result.ok) {
      // paid_after_cancel / stale：已經在 repo 裡告警過了。回 200，重送不會變好。
      await annotateWebhookEvent(
        eventKey,
        { apn: body, query: q.result.raw, refused: result.reason },
        GATEWAY,
      );
      return text(`OK (${result.reason})`);
    }

    // ---------- 付款確認之後：貨 → 憑證 → 信 ----------
    // ⚠️ 這三行的先後有理由，不要重排；理由寫在 payuni-webhook.ts 的同一段。
    // ⚠️ 三步的失敗都**絕不**改變回給黑貓的答案 —— 回 5xx 換來的是同一則通知
    //    被重送三次，而這三支都自己吞掉錯誤、從不 throw，失敗各自留在
    //    stock_oversold_alerts / invoices / email_outbox 由排程補。
    const { commitInventoryForOrder } = await import("@/server/repos/orders");
    await commitInventoryForOrder(order.id);

    const { triggerInvoiceAfterPayment } = await import("@/server/invoice-issuer");
    const invoice = await triggerInvoiceAfterPayment(order.id);
    if (!invoice.ok) {
      console.warn(
        `[blackcat] order=${orderNo} 已標記付款成功，但發票尚未開出（${invoice.reason}）——已列入補開清單`,
      );
    }

    const { triggerNotifyAfterPayment } = await import("@/server/notify");
    const notifyOutcome = await triggerNotifyAfterPayment(order.id);
    if (!notifyOutcome.ok) {
      console.warn(
        `[blackcat] order=${orderNo} 已標記付款成功，但通知信尚未排出（${notifyOutcome.reason}）——已列入補寄清單`,
      );
    }

    return text("OK");
  }

  if (failed) {
    const outcome = await markPaymentFailed(order, {
      reason: `blackcat_process_code_${processCode ?? "unknown"}`,
      raw: { apn: body, query: q.result.raw },
      gateway: GATEWAY,
    });
    if (outcome === "db_error") return retryable("order update failed; please retry");
    return text("OK");
  }

  // 還在路上的狀態（13 刷卡確認頁 / 14 繳款人確認 / 20 之前的各種中間態，
  // 以及 P 請款失敗、N 取消交易失敗這種「授權還在、錢還在」的狀態）：
  // 只 ack，不動訂單，等後續通知。event_key 含 status，所以之後那則
  // 「授權完成」的通知是不同的 key，不會被這一則的 claim 擋掉。
  console.info(`[blackcat] order=${orderNo} process_code=${processCode} 尚未觸發任何狀態轉移`);
  return text("OK");
}

// ═══════════════════════════════════════════════════════════════════════════
// 瀏覽器導回
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 客人刷完卡被導回來的地方。
 *
 * 🔴 **這支 handler 絕對不會標記任何付款狀態。** 它只做一件事：把客人送到訂單
 *    確認頁。理由是導回是**客人的瀏覽器**發起的，網址列裡的東西客人自己就能改；
 *    而且客人完全可能在導回之前就關掉分頁 —— 把付款狀態綁在導回上，等於讓
 *    「有沒有收到錢」取決於客人有沒有等頁面跳完。錢的真相只有一個來源：APN
 *    走完上面第 ② 層的回查。
 *
 *    chk 驗簽在這裡的用途只有一個：決定要不要在確認頁上顯示「授權失敗」的提示，
 *    以免客人對著一張還在 pending 的訂單一直等。
 *
 * ── 兩條 chk 公式（規格 P46 / P48），與 APN 的 checksum 是**完全不同的兩套** ──
 *      成功 MD5(hash_base +'$'+ order_amount +'$'+ send_time +'$'+ ret +'$'+
 *               acquire_time +'$'+ auth_code +'$'+ card_no +'$'+ notify_time +'$'+
 *               cust_order_no)                                       ← 9 段
 *      失敗 MD5(hash_base +'$'+ order_amount +'$'+ send_time +'$'+ ret +'$'+
 *               notify_time +'$'+ cust_order_no)                     ← 6 段
 *    `$` 分隔、**含 hash_base**（所以它才真的擋得住偽造，與 APN 相反）。
 *    分派邏輯在 blackcat.ts verifyReturnChk()。
 *
 * ⚠️ **失敗那一條在這家店大概永遠不會被呼叫到，那不是壞掉。**
 *    規格 P48 明寫：授權失敗轉址「僅玉山銀、中信銀可用，**統一金流授權失敗後不會
 *    轉址，會停留在失敗結果頁**」。這家店的收單行就是統一金流（acquirer_type
 *    預設 payuni），所以客人刷卡失敗時看到的是黑貓自己的失敗頁，不會回到我們這裡。
 *    下一個人看到 ret=FAIL 這條分支在 log 裡從來沒出現過，請不要把它當成死碼刪掉 ——
 *    它是「哪天換成玉山或中信收單」的唯一準備，而且刪掉之後不會有任何測試變紅。
 *
 * ⚠️ token 的兩個來源：
 *      ?t=  建單時由 blackcatReturnUrl(publicToken) 組進 success_url 的。
 *      沒有 ?t= 時 → 用 cust_order_no 回查 orders 拿 public_token。
 *    後者是必要的：黑貓 PAY 後台那兩格「重新導向契客網址」是**靜態設定**，
 *    填不進每張訂單各自的 token，所以從後台設定過來的導回一定沒有 ?t=。
 */
export async function handleBlackcatReturn(req: Request): Promise<Response> {
  let params: URLSearchParams;
  let origin: string;
  try {
    const url = new URL(req.url);
    params = url.searchParams;
    origin = url.origin;
  } catch {
    return text("bad request", 400);
  }

  const complete = (token: string | null, failed: boolean): Response => {
    if (!token) return redirect(`${origin}/`);
    const q = new URLSearchParams({ token });
    if (failed) q.set("payment", "failed");
    return redirect(`${origin}/checkout/complete?${q.toString()}`);
  };

  let token = params.get("t");

  // 沒有 ?t= 就用 cust_order_no 找回訂單（後台靜態設定過來的導回一定走這條）。
  if (!token) {
    const orderNo = (params.get("cust_order_no") ?? "").trim();
    if (orderNo) {
      try {
        const { findOrderByOrderNo } = await import("@/server/repos/payments");
        const order = await findOrderByOrderNo(orderNo);
        token = order?.public_token ?? null;
      } catch (err) {
        console.error(
          `[blackcat] 導回查不到訂單 order_no=${orderNo}: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
    }
  }

  const ret = params.get("ret");
  // chk 驗不過就當成「不知道結果」——**不顯示失敗**。顯示一個假的失敗提示，
  // 會讓一位其實已經付款成功的客人跑去重刷一次。
  const verified = verifyReturnChk(params);
  if (!verified && params.get("chk")) {
    console.warn(
      `[blackcat] 導回 chk 驗簽失敗，忽略其內容 order_no=${params.get("cust_order_no")}`,
    );
  }
  const failed = verified && ret !== null && ret !== "OK";

  return complete(token, failed);
}
