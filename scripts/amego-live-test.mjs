#!/usr/bin/env node
/**
 * Amego 端到端實測 —— 真的開發票、真的作廢。
 *
 * ⚠️⚠️ 這支腳本會對 Amego 產生**真實副作用**。開出去的發票撤不回來，只能作廢。
 * 因此有兩道閘門，兩道都是刻意設計成「預設不會跑」：
 *
 *   1. 必須 AMEGO_LIVE=1
 *   2. 賣方統編必須是文件公開的測試統編 12345678。**不是測試統編就直接拒絕執行** ——
 *      這支腳本永遠不該碰到正式環境。要驗正式環境，請在 Amego 後台用他們的介面。
 *
 * 這也是它不進 CI 的原因（見 scripts/run-selftests.mjs 的 ALLOWLIST）：每次 push 都
 * 去第三方開一張測試發票既不禮貌，也會讓 CI 依賴外部服務的可用性。
 *
 * 執行：
 *   AMEGO_INVOICE_BAN=12345678 AMEGO_APP_KEY=sHeq7t8G1wiQvhAuIM27 \
 *   AMEGO_LIVE=1 node scripts/amego-live-test.mjs
 *
 * 收尾會把這一輪開出來的發票**全部作廢**，並印出作廢回應。中途失敗也會跑清理。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.env.AMEGO_LIVE !== "1") {
  console.error("✗ 這支腳本會真的開發票。確定要跑請設 AMEGO_LIVE=1。");
  process.exit(2);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(`file://${join(ROOT, "src/server/amego.ts")}`);

const {
  AMEGO_TEST_BAN,
  amegoBan,
  amegoConfigured,
  amegoIsTestEnv,
  computeInvoiceAmounts,
  findInvoiceByOrderId,
  issueInvoice,
  syncAmegoClock,
  voidInvoice,
} = mod;

if (!amegoConfigured()) {
  console.error("✗ 缺 AMEGO_INVOICE_BAN / AMEGO_APP_KEY。");
  process.exit(2);
}
if (!amegoIsTestEnv()) {
  console.error(
    `✗ 賣方統編是 ${amegoBan()}，不是測試統編 ${AMEGO_TEST_BAN}。` +
      `這支腳本只准跑在測試環境 —— 它會開出真的發票。`,
  );
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
    console.log(`        expected: ${expected}`);
    console.log(`        actual:   ${actual}`);
  }
}
const checkTrue = (n, a) => check(n, a === true, true);

/** 這一輪開出來的發票，收尾要全部作廢。 */
const issued = [];
const stamp = Date.now();

console.log(`\nAmego 端到端實測（測試統編 ${amegoBan()}）`);

// ── 0. 校時：±60 秒的第一道保險 ──────────────────────────────────────────
console.log("\n[0] 校時 GET /json/time");
const offset = await syncAmegoClock();
console.log(`  本機時間與 Amego 相差 ${offset} 秒（±60 秒內才簽得過）`);
checkTrue("時鐘在 ±60 秒內", Math.abs(offset) < 60);

try {
  // ── 1. B2C 開立 ─────────────────────────────────────────────────────────
  console.log("\n[1] B2C 開立（無統編 → 稅額 0）");
  const b2cOrder = `LIVE-B2C-${stamp}`;
  const b2c = await issueInvoice({
    orderId: b2cOrder,
    buyerName: "測試客人",
    lines: [{ description: "小時光書店測試書籍", quantity: 1, unitPrice: 350, amount: 350 }],
  });
  console.log("  回應：", JSON.stringify(b2c.ok ? b2c.data : b2c));
  checkTrue("開立成功", b2c.ok);
  if (b2c.ok) {
    issued.push(b2c.invoice.invoiceNumber);
    checkTrue("拿到發票號碼", /^[A-Z]{2}\d{8}$/.test(b2c.invoice.invoiceNumber));
    checkTrue("拿到 4 碼隨機碼", /^\d{4}$/.test(b2c.invoice.randomNumber));
    console.log(
      `  → 發票號碼 ${b2c.invoice.invoiceNumber}　隨機碼 ${b2c.invoice.randomNumber}　條碼 ${b2c.invoice.barcode}`,
    );
  }

  // ── 2. 反查：伺服器記的金額要與我們算的一致 ──────────────────────────────
  console.log("\n[2] 用 OrderId 反查（重試路徑的冪等來源）");
  const q = await findInvoiceByOrderId(b2cOrder);
  checkTrue("查得到", q.ok && q.hit !== null);
  if (q.ok && q.hit) {
    check("查回同一張發票", q.hit.invoiceNumber, b2c.invoice.invoiceNumber);
    check("伺服器記的總額 = 350", q.hit.totalAmount, 350);
    console.log("  → ", JSON.stringify(q.hit));
  }

  // ── 3. OrderId 重複：HTTP 200 但業務錯誤碼 ──────────────────────────────
  console.log("\n[3] 同一個 OrderId 再開一次（冪等訊號）");
  const dup = await issueInvoice({
    orderId: b2cOrder,
    buyerName: "測試客人",
    lines: [{ description: "小時光書店測試書籍", quantity: 1, unitPrice: 350, amount: 350 }],
  });
  console.log("  回應：", JSON.stringify(dup.ok ? dup.data : { code: dup.code, msg: dup.msg }));
  check("被判為失敗（不是因為 HTTP 狀態碼，而是因為 code）", dup.ok, false);
  check("code = 3040171 OrderId 重複", dup.code, 3040171);
  check("沒有生出第二張發票", dup.invoice, undefined);

  // ── 4. B2B：稅額分拆要與伺服器一致 ──────────────────────────────────────
  console.log("\n[4] B2B 開立（打統編 → 分拆 5% 稅額）");
  const b2bOrder = `LIVE-B2B-${stamp}`;
  const b2bAmounts = computeInvoiceAmounts(
    [{ description: "x", quantity: 1, unitPrice: 1000, amount: 1000 }],
    { hasTaxId: true },
  );
  console.log(
    `  我們算出來：sales=${b2bAmounts.salesAmount} tax=${b2bAmounts.taxAmount} total=${b2bAmounts.totalAmount}`,
  );
  const b2b = await issueInvoice({
    orderId: b2bOrder,
    taxId: "53212539",
    buyerName: "高思數位網路有限公司",
    lines: [{ description: "小時光書店測試書籍", quantity: 1, unitPrice: 1000, amount: 1000 }],
  });
  console.log("  回應：", JSON.stringify(b2b.ok ? b2b.data : b2b));
  checkTrue("開立成功", b2b.ok);
  if (b2b.ok) issued.push(b2b.invoice.invoiceNumber);

  const qb = await findInvoiceByOrderId(b2bOrder);
  if (qb.ok && qb.hit) {
    check("伺服器記的總額與我們算的一致", qb.hit.totalAmount, b2bAmounts.totalAmount);
  }

  // ── 5. 多品項 + 運費 + 折扣負數列 ───────────────────────────────────────
  console.log("\n[5] 多品項 + 運費 + 折扣負數列");
  const multiOrder = `LIVE-MULTI-${stamp}`;
  const multiLines = [
    { description: "書 A", quantity: 2, unitPrice: 350, amount: 700 },
    { description: "書 B", quantity: 1, unitPrice: 180, amount: 180 },
    { description: "運費", quantity: 1, unitPrice: 100, amount: 100 },
    { description: "折扣", quantity: 1, unitPrice: -80, amount: -80 },
  ];
  const expectTotal = multiLines.reduce((a, l) => a + l.amount, 0);
  const multi = await issueInvoice({
    orderId: multiOrder,
    buyerName: "測試客人",
    lines: multiLines,
  });
  console.log("  回應：", JSON.stringify(multi.ok ? multi.data : multi));
  checkTrue("開立成功", multi.ok);
  if (multi.ok) issued.push(multi.invoice.invoiceNumber);
  const qm = await findInvoiceByOrderId(multiOrder);
  if (qm.ok && qm.hit) check(`伺服器記的總額 = ${expectTotal}`, qm.hit.totalAmount, expectTotal);

  // ── 6. 金額算錯：HTTP 200 但被擋 ────────────────────────────────────────
  console.log("\n[6] 故意送錯的 TotalAmount（證明 200 不等於成功）");
  const { amegoRequest } = mod;
  const bad = await amegoRequest("/json/f0401", {
    OrderId: `LIVE-BAD-${stamp}`,
    BuyerIdentifier: "0000000000",
    BuyerName: "測試客人",
    ProductItem: [
      { Description: "壞掉的單", Quantity: "1", UnitPrice: "100", Amount: "100", TaxType: "1" },
    ],
    SalesAmount: "100",
    FreeTaxSalesAmount: "0",
    ZeroTaxSalesAmount: "0",
    TaxType: "1",
    TaxRate: "0.05",
    TaxAmount: "0",
    TotalAmount: "999",
  });
  console.log("  回應：", JSON.stringify({ code: bad.code, msg: bad.msg }));
  check("被判為失敗", bad.ok, false);
  check("code = 3040178 TotalAmount 計算錯誤", bad.code, 3040178);

  // ── 7. 查一個不存在的 OrderId ───────────────────────────────────────────
  console.log("\n[7] 查不存在的 OrderId（重試前判斷「還沒開過」的依據）");
  const none = await findInvoiceByOrderId(`LIVE-NOPE-${stamp}`);
  checkTrue("查詢本身算成功", none.ok);
  check("hit 為 null（= 還沒開過，不是錯誤）", none.hit, null);
} finally {
  // ── 8. 清理：全部作廢 ───────────────────────────────────────────────────
  console.log(`\n[8] 清理：作廢這一輪開出的 ${issued.length} 張`);
  for (const number of issued) {
    const v = await voidInvoice({ invoiceNumber: number, reason: "端到端測試清理" });
    console.log(
      `  作廢 ${number} → ${JSON.stringify(v.ok ? v.data : { code: v.code, msg: v.msg })}`,
    );
    check(`作廢 ${number} 成功`, v.ok, true);
  }
  // 重複作廢同一張 → 業務錯誤碼，不是成功
  if (issued.length > 0) {
    const again = await voidInvoice({ invoiceNumber: issued[0], reason: "重複作廢" });
    console.log(
      `  重複作廢 ${issued[0]} → ${JSON.stringify({ code: again.code, msg: again.msg })}`,
    );
    check("重複作廢被擋（3050131 等待作廢）", again.code, 3050131);
  }
}

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=scripts/amego-live-test.mjs pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m\n`);
  process.exit(0);
}
console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(1);
