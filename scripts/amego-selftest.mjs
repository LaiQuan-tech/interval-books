#!/usr/bin/env node
// 光貿 Amego 電子發票自檢 —— 不打網路，不需要任何憑證。
//
// ⚠️ 這支腳本刻意「直接 import 產線那一份 src/server/amego.ts」（靠 Node 原生
// TypeScript 型別剝離，不經 bundler），不複製一份簽章／金額邏輯 —— 複製品驗過了
// 不代表產線那份是對的。與 scripts/payuni-selftest.mjs 同一個作法。
//
// 網路呼叫用一個假的 globalThis.fetch 攔下來，所以：
//   * CI 跑得動，不依賴 Amego 可用性，也不會在別人的測試環境開出真發票
//   * 「HTTP 200 但業務錯誤碼」「時鐘漂移後校時重送」這兩條路徑驗得到 ——
//     它們在真實環境很難重現，卻正是最容易寫錯的地方
//
// 真的對 Amego 開一張發票、再作廢的端到端驗證在 scripts/amego-live-test.mjs
// （需要 AMEGO_LIVE=1，刻意不進 CI）。
//
// 執行：node scripts/amego-selftest.mjs   （或 npm run test:amego）
// 需求：Node >= 22.6（型別剝離）。

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `✗ 需要 Node >= 22.6 才能直接 import TypeScript 原始碼（目前 ${process.versions.node}）`,
  );
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = join(ROOT, "src/server/amego.ts");

// 環境變數要在 import 之前設好：模組頂層雖然沒讀，但讓每個 case 從同一個起點跑。
process.env.AMEGO_INVOICE_BAN = "12345678";
process.env.AMEGO_APP_KEY = "sHeq7t8G1wiQvhAuIM27";
delete process.env.AMEGO_API_BASE;

let mod;
try {
  mod = await import(`file://${MODULE_PATH}`);
} catch (err) {
  console.error(`✗ 無法載入 ${MODULE_PATH}`);
  console.error(err);
  process.exit(1);
}

const {
  AMEGO_DEFAULT_BASE,
  AMEGO_CODE_CARRIER_NOT_FOUND,
  AMEGO_CODE_DUPLICATE_ORDER,
  AMEGO_CODE_NOT_FOUND,
  AMEGO_CODE_SIGN,
  AMEGO_CODE_TIME,
  ANONYMOUS_BUYER_ID,
  ANONYMOUS_BUYER_NAME,
  amegoBan,
  amegoClockOffset,
  amegoConfigured,
  amegoIsTestEnv,
  amegoNow,
  amegoRequest,
  amegoSign,
  buildAmegoBody,
  buildIssuePayload,
  computeInvoiceAmounts,
  findInvoiceByOrderId,
  isCarrierRejection,
  isPermanentAmegoError,
  isValidTaxId,
  issueInvoice,
  resetAmegoClockOffset,
  taipeiYmd,
  voidInvoice,
} = mod;

// ── 迷你測試框架 ──────────────────────────────────────────────────────────
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

const checkTrue = (name, actual) => check(name, actual === true, true);
const checkFalse = (name, actual) => check(name, actual === false, true);

// ── 假的 fetch ────────────────────────────────────────────────────────────
// 記下每一次請求，並照劇本回應。所有 Amego 回應都是 HTTP 200，成敗看 body.code ——
// 假 fetch 也照這個事實走，否則測到的就不是真的行為。
const calls = [];
let script = [];

function installFetch() {
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const entry = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {} };
    if (init.body && typeof init.body.get === "function") {
      entry.fields = {
        invoice: init.body.get("invoice"),
        data: init.body.get("data"),
        time: init.body.get("time"),
        sign: init.body.get("sign"),
      };
      entry.rawBody = init.body.toString();
    }
    calls.push(entry);
    const next = script.shift();
    if (!next) throw new Error(`假 fetch 劇本用完了，但又被呼叫了一次：${entry.url}`);
    if (typeof next === "function") return next(entry);
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const TEST_KEY = "sHeq7t8G1wiQvhAuIM27";

// ── 1. 設定 ───────────────────────────────────────────────────────────────
console.log("\n[1] 設定");
check("預設 base", AMEGO_DEFAULT_BASE, "https://invoice-api.amego.tw");
check("統編讀得到", amegoBan(), "12345678");
checkTrue("設定完整 → amegoConfigured()", amegoConfigured());
checkTrue("12345678 被認出是測試統編", amegoIsTestEnv());
{
  const saved = process.env.AMEGO_APP_KEY;
  delete process.env.AMEGO_APP_KEY;
  checkFalse(
    "缺 App Key → amegoConfigured() 為 false（fail-safe，不帶空金鑰去打）",
    amegoConfigured(),
  );
  process.env.AMEGO_APP_KEY = saved;
}

// ── 2. 簽章 ───────────────────────────────────────────────────────────────
// sign = md5(data 的 JSON 字串 + time + AppKey)。這裡用「另一種算法」重算一次
// （手寫字串串接 + node:crypto），而不是拿 amegoSign 自己的輸出比自己 —— 自我驗證
// 等於沒驗。
console.log("\n[2] 簽章 = md5(data + time + AppKey)");
{
  const dataJson = '{"type":"order","order_id":"IB-202600000042"}';
  const time = 1786377494;
  const expected = createHash("md5")
    .update(dataJson + time + TEST_KEY)
    .digest("hex");
  check("與獨立算式一致", amegoSign(dataJson, time, TEST_KEY), expected);
  check("time 傳字串或數字結果相同", amegoSign(dataJson, String(time), TEST_KEY), expected);
  check("md5 是 32 個 hex 字元", /^[0-9a-f]{32}$/.test(amegoSign(dataJson, time, TEST_KEY)), true);

  // 文件裡最容易踩的一條：簽的是「未 url encode」的原字串。
  const encoded = encodeURIComponent(dataJson);
  check(
    "簽 url-encoded 字串會得到不同結果（所以絕不可以簽 encode 過的）",
    amegoSign(encoded, time, TEST_KEY) === expected,
    false,
  );

  // 三個輸入各自改動都要換到不同簽章。
  check("換 AppKey → 不同簽章", amegoSign(dataJson, time, "other-key") === expected, false);
  check("換 time → 不同簽章", amegoSign(dataJson, time + 1, TEST_KEY) === expected, false);
  check("換 data → 不同簽章", amegoSign(dataJson + " ", time, TEST_KEY) === expected, false);

  // 含中文的 data 必須以 UTF-8 計算（Amego 收到的就是 UTF-8）。
  const zh = '{"Description":"測試書籍"}';
  check(
    "中文 data 以 UTF-8 計算",
    amegoSign(zh, time, TEST_KEY),
    createHash("md5")
      .update(Buffer.from(zh + time + TEST_KEY, "utf8"))
      .digest("hex"),
  );
}

console.log("\n[3] form body 四個欄位");
{
  const dataJson = '{"a":1}';
  const body = buildAmegoBody({ ban: "12345678", dataJson, time: 1786377494, appKey: TEST_KEY });
  check("invoice", body.get("invoice"), "12345678");
  check("data 原字串（URLSearchParams 送出時才 encode）", body.get("data"), dataJson);
  check("time", body.get("time"), "1786377494");
  check("sign 對得起來", body.get("sign"), amegoSign(dataJson, 1786377494, TEST_KEY));
  check("剛好四個欄位", [...body.keys()].sort().join(","), "data,invoice,sign,time");
  checkTrue("送出時 data 會被 url encode", body.toString().includes("data=%7B%22a%22%3A1%7D"));
}

// ── 4. 金額（文件規則，三組以上）──────────────────────────────────────────
// 最反直覺的一條：**沒打統編時稅額一律 0**，不分拆。B2C 含稅價 100 的發票在 Amego
// 就是 sales=100 tax=0 total=100（實測 ZA10034112 查回來就是這三個數）。
console.log("\n[4] 金額計算");
{
  const L = (amount, taxType) => ({
    description: "x",
    quantity: 1,
    unitPrice: amount,
    amount,
    taxType,
  });

  // (a) B2C 單品項含稅 100
  const a = computeInvoiceAmounts([L(100)], { hasTaxId: false });
  check("B2C 100 → SalesAmount", a.salesAmount, 100);
  check("B2C 100 → TaxAmount 為 0（不分拆）", a.taxAmount, 0);
  check("B2C 100 → TotalAmount", a.totalAmount, 100);

  // (b) B2B 同樣含稅 100 → 95 + 5（實測 ZA10034113 伺服器回的就是這組）
  const b = computeInvoiceAmounts([L(100)], { hasTaxId: true });
  check("B2B 100 → SalesAmount 被覆寫成未稅", b.salesAmount, 95);
  check("B2B 100 → TaxAmount = 100 - Round(100/1.05)", b.taxAmount, 5);
  check("B2B 100 → TotalAmount 仍是含稅總額", b.totalAmount, 100);

  // (c) 多品項 + 運費 + 折扣負數列（實測 ZA10034114 這組真的開得出來）
  const multi = [
    { description: "書 A", quantity: 2, unitPrice: 350, amount: 700 },
    { description: "書 B", quantity: 1, unitPrice: 180, amount: 180 },
    { description: "運費", quantity: 1, unitPrice: 100, amount: 100 },
    { description: "折扣", quantity: 1, unitPrice: -80, amount: -80 },
  ];
  const c = computeInvoiceAmounts(multi, { hasTaxId: false });
  check("多品項 B2C → SalesAmount 含折扣負數列", c.salesAmount, 900);
  check("多品項 B2C → TaxAmount 0", c.taxAmount, 0);
  check("多品項 B2C → TotalAmount", c.totalAmount, 900);

  const cb = computeInvoiceAmounts(multi, { hasTaxId: true });
  check(
    "多品項 B2B → TaxAmount = 900 - Round(900/1.05)",
    cb.taxAmount,
    900 - Math.round(900 / 1.05),
  );
  check("多品項 B2B → SalesAmount + TaxAmount = 900", cb.salesAmount + cb.taxAmount, 900);
  check("多品項 B2B → TotalAmount 不因分拆而改變", cb.totalAmount, 900);

  // (d) 除不盡：Round 是四捨五入，不是無條件捨去
  const d = computeInvoiceAmounts([L(333)], { hasTaxId: true });
  check("B2B 333 → TaxAmount = 333 - Round(317.14) = 16", d.taxAmount, 16);
  check("B2B 333 → SalesAmount = 317", d.salesAmount, 317);
  check("B2B 333 → 合計仍是 333", d.totalAmount, 333);

  const e = computeInvoiceAmounts([L(1)], { hasTaxId: true });
  check("B2B 1 元 → Round(1/1.05)=1，TaxAmount 0", e.taxAmount, 0);
  check("B2B 1 元 → TotalAmount 1", e.totalAmount, 1);

  // (e) 免稅／零稅率分開加總，且不參與 5% 分拆
  const mixed = [L(100, "1"), L(50, "3"), L(30, "2")];
  const f = computeInvoiceAmounts(mixed, { hasTaxId: false });
  check("免稅列進 FreeTaxSalesAmount", f.freeTaxSalesAmount, 50);
  check("零稅率列進 ZeroTaxSalesAmount", f.zeroTaxSalesAmount, 30);
  check("應稅列進 SalesAmount", f.salesAmount, 100);
  check("TotalAmount 是三者相加", f.totalAmount, 180);

  const g = computeInvoiceAmounts(mixed, { hasTaxId: true });
  check("B2B 混合 → 只有應稅的部分被分拆", g.taxAmount, 100 - Math.round(100 / 1.05));
  check("B2B 混合 → 免稅金額不變", g.freeTaxSalesAmount, 50);
  check("B2B 混合 → TotalAmount 不變", g.totalAmount, 180);

  check("空明細 → 全 0", computeInvoiceAmounts([], { hasTaxId: false }).totalAmount, 0);
}

// ── 5. 統編檢核碼 ─────────────────────────────────────────────────────────
console.log("\n[5] 統編檢核碼");
checkTrue("53212539（實測 ban_query 查回「高思數位網路有限公司」）", isValidTaxId("53212539"));
checkTrue("04595257（台積電）", isValidTaxId("04595257"));
checkFalse("12345679（實測回 3040122 BuyerIdentifier 格式錯誤）", isValidTaxId("12345679"));
// ⚠️ Amego 自己的測試統編 12345678 **通不過**財政部檢核碼（總和 42，非 5 的倍數）。
// 這正是 isValidTaxId() 只用來檢查「買方統編」、絕不拿去檢查我們自己的賣方統編
// （AMEGO_INVOICE_BAN）的原因 —— 拿去檢查賣方，測試環境會整個開不了發票。
checkFalse("12345678（Amego 測試統編，檢核碼其實不合法）", isValidTaxId("12345678"));
checkFalse("7 碼", isValidTaxId("1234567"));
checkFalse("9 碼", isValidTaxId("123456789"));
checkFalse("含字母", isValidTaxId("1234567A"));
checkFalse("空字串", isValidTaxId(""));
checkTrue("前後空白會被 trim", isValidTaxId("  53212539 "));

// ── 6. 開立 payload ───────────────────────────────────────────────────────
console.log("\n[6] 開立 payload");
{
  const lines = [{ description: "書", quantity: 1, unitPrice: 350, amount: 350 }];

  const b2c = buildIssuePayload({ orderId: "IB-202600000042", lines });
  check("無統編 → BuyerIdentifier 0000000000", b2c.BuyerIdentifier, ANONYMOUS_BUYER_ID);
  check("無買方姓名 → 消費者（不可填 0，會被擋 3040123）", b2c.BuyerName, ANONYMOUS_BUYER_NAME);
  check("TaxRate 是字串 0.05", b2c.TaxRate, "0.05");
  check("金額全部轉字串", typeof b2c.TotalAmount, "string");
  check("B2C TaxAmount 0", b2c.TaxAmount, "0");
  check("ProductItem 是陣列", Array.isArray(b2c.ProductItem), true);
  check("明細數量是字串", b2c.ProductItem[0].Quantity, "1");
  check("明細預設應稅", b2c.ProductItem[0].TaxType, "1");
  check("沒有 email 就不帶 BuyerEmailAddress", "BuyerEmailAddress" in b2c, false);
  check("沒有載具就不帶 CarrierType", "CarrierType" in b2c, false);

  const b2b = buildIssuePayload({
    orderId: "IB-1",
    taxId: "53212539",
    buyerName: "高思數位網路有限公司",
    lines: [{ description: "書", quantity: 1, unitPrice: 100, amount: 100 }],
  });
  check("有統編 → BuyerIdentifier 帶統編", b2b.BuyerIdentifier, "53212539");
  check("有統編 → SalesAmount 未稅", b2b.SalesAmount, "95");
  check("有統編 → TaxAmount 5", b2b.TaxAmount, "5");
  check("有統編 → TotalAmount 100", b2b.TotalAmount, "100");

  const b2bNoTitle = buildIssuePayload({ orderId: "IB-2", taxId: "53212539", lines });
  check(
    "有統編但沒抬頭 → 退回消費者（BuyerName 不可為空）",
    b2bNoTitle.BuyerName,
    ANONYMOUS_BUYER_NAME,
  );

  const carrier = buildIssuePayload({
    orderId: "IB-3",
    lines,
    carrierType: "3J0002",
    carrierId: "/ABC1234",
  });
  check("載具 type", carrier.CarrierType, "3J0002");
  check("載具顯碼", carrier.CarrierId1, "/ABC1234");
  check("載具隱碼與顯碼相同", carrier.CarrierId2, "/ABC1234");

  const donate = buildIssuePayload({ orderId: "IB-4", lines, loveCode: "25885" });
  check("捐贈 → NPOBAN", donate.NPOBAN, "25885");
  check("捐贈時不帶載具", "CarrierType" in donate, false);

  const both = buildIssuePayload({
    orderId: "IB-5",
    lines,
    loveCode: "25885",
    carrierType: "3J0002",
    carrierId: "/ABC1234",
  });
  check("捐贈與載具同時給 → 捐贈優先（互斥）", "CarrierType" in both, false);

  const b2bCarrier = buildIssuePayload({
    orderId: "IB-6",
    taxId: "53212539",
    lines,
    carrierType: "3J0002",
    carrierId: "/ABC1234",
  });
  check("有統編時不帶載具（B2B 發票沒有載具可言）", "CarrierType" in b2bCarrier, false);

  const email = buildIssuePayload({ orderId: "IB-7", lines, buyerEmail: "a@example.test" });
  check("有 email 就帶 BuyerEmailAddress", email.BuyerEmailAddress, "a@example.test");

  const neg = buildIssuePayload({
    orderId: "IB-8",
    lines: [
      { description: "書", quantity: 1, unitPrice: 350, amount: 350 },
      { description: "折扣", quantity: 1, unitPrice: -50, amount: -50 },
    ],
  });
  check("折扣是負數明細列（不是另外的欄位）", neg.ProductItem[1].Amount, "-50");
  check("折扣後 TotalAmount", neg.TotalAmount, "300");
}

// ── 7. 錯誤碼分類 ─────────────────────────────────────────────────────────
// 白名單制：只有明確知道重試有機會成功的才算可重試。判斷錯的兩個方向後果不對稱
// ——把可重試當永久失敗，客人的發票就永遠不會開出來。
console.log("\n[7] 錯誤碼分類");
checkFalse("傳輸層失敗（code=null）可重試", isPermanentAmegoError(null));
checkFalse("15 時間戳記錯誤可重試（校時後有機會成功）", isPermanentAmegoError(AMEGO_CODE_TIME));
checkTrue("16 簽章錯誤是永久失敗（金鑰不對）", isPermanentAmegoError(AMEGO_CODE_SIGN));
checkTrue("3040122 統編格式錯誤是永久失敗", isPermanentAmegoError(3040122));
checkTrue("3040132 載具不存在是永久失敗", isPermanentAmegoError(3040132));
checkTrue("3040178 TotalAmount 計算錯誤是永久失敗", isPermanentAmegoError(3040178));
checkTrue("未知錯誤碼保守當永久失敗（停下來讓人看見）", isPermanentAmegoError(9999999));

// 「永久失敗」不等於「這張訂單沒有發票」。3040132 是唯一一個可以靠**拿掉載具**
// 救回來的碼：載具只決定發票存在哪裡，不決定它存不存在。這一組守著那個分類 ——
// 分錯的後果是客人打錯一碼手機條碼就永遠拿不到發票（實測發生過，IB-202600000042）。
checkTrue("3040132 載具不存在 → 可用「拿掉載具重開」救回", isCarrierRejection(3040132));
check("isCarrierRejection 用的就是那個常數", AMEGO_CODE_CARRIER_NOT_FOUND, 3040132);
checkFalse("3040122 統編格式錯不屬於這一類（拿掉載具也沒用）", isCarrierRejection(3040122));
checkFalse("3040178 金額算錯不屬於這一類", isCarrierRejection(3040178));
checkFalse("3040171 OrderId 重複不屬於這一類（那是冪等訊號）", isCarrierRejection(3040171));
checkFalse("傳輸層失敗（code=null）不屬於這一類", isCarrierRejection(null));
checkTrue("而且它仍然是永久失敗（重試同一個載具永遠同一個答案）", isPermanentAmegoError(3040132));

// 降級開立時送出去的 payload 真的不帶載具 —— 分類對了但 payload 還帶著載具的話，
// 第二次會拿到一模一樣的 3040132。
{
  const withCarrier = buildIssuePayload({
    orderId: "IB-1",
    lines: [{ description: "書", quantity: 1, unitPrice: 210, amount: 210 }],
    carrierType: "3J0002",
    carrierId: "/ABC1234",
  });
  const without = buildIssuePayload({
    orderId: "IB-1",
    lines: [{ description: "書", quantity: 1, unitPrice: 210, amount: 210 }],
    carrierType: null,
    carrierId: null,
  });
  check("帶載具時 payload 有 CarrierType", withCarrier.CarrierType, "3J0002");
  checkTrue("拿掉載具後 payload 沒有 CarrierType", !("CarrierType" in without));
  checkTrue("拿掉載具後 payload 沒有 CarrierId1", !("CarrierId1" in without));
  check("兩者的 TotalAmount 完全一樣（降級不動金額）", without.TotalAmount, withCarrier.TotalAmount);
  check("兩者的 OrderId 一樣（靠 Amego 的唯一性防重複開立）", without.OrderId, withCarrier.OrderId);
}

// ── 8. HTTP 200 + 業務錯誤碼 = 失敗 ───────────────────────────────────────
// 這一組是整支測試的重點：Amego **所有**回應都是 HTTP 200。把 res.ok 當成功，
// 就是把「統編格式錯誤」當成「發票開好了」。
console.log("\n[8] HTTP 200 但業務錯誤碼");
{
  installFetch();
  resetAmegoClockOffset();

  script = [{ code: 3040178, msg: "TotalAmount 計算錯誤" }];
  let r = await amegoRequest("/json/f0401", { OrderId: "X" });
  checkFalse("code 3040178 判為失敗", r.ok);
  check("kind = business", r.kind, "business");
  check("code 保留下來供分類", r.code, 3040178);
  check("msg 保留下來", r.msg, "TotalAmount 計算錯誤");

  script = [{ code: 0, msg: "", invoice_number: "ZA10034112" }];
  r = await amegoRequest("/json/f0401", { OrderId: "X" });
  checkTrue("code 0 才算成功", r.ok);
  check("成功時帶回 body", r.data.invoice_number, "ZA10034112");

  // 200 但不是 JSON（維護頁 / WAF 擋頁）→ 傳輸層失敗，可重試
  script = [() => new Response("<html>maintenance</html>", { status: 200 })];
  r = await amegoRequest("/json/f0401", { OrderId: "X" });
  checkFalse("HTTP 200 但非 JSON 判為失敗", r.ok);
  check("非 JSON → kind transport（可重試）", r.kind, "transport");

  // 連線爆掉
  script = [
    () => {
      throw new Error("ECONNRESET");
    },
  ];
  r = await amegoRequest("/json/f0401", { OrderId: "X" });
  check("連線失敗 → kind transport", r.kind, "transport");
  check("連線失敗 → code 為 null", r.code, null);

  // issueInvoice：業務錯誤時不可以生出 invoice 物件
  script = [{ code: 3040171, msg: "OrderId 重複" }];
  const dup = await issueInvoice({
    orderId: "IB-1",
    lines: [{ description: "x", quantity: 1, unitPrice: 1, amount: 1 }],
  });
  checkFalse("issueInvoice 失敗時 ok=false", dup.ok);
  check("issueInvoice 失敗時沒有 invoice", dup.invoice, undefined);
  check("OrderId 重複的碼是 3040171（冪等訊號）", dup.code, AMEGO_CODE_DUPLICATE_ORDER);

  script = [
    {
      code: 0,
      msg: "",
      invoice_number: "ZA10034112",
      random_number: "1618",
      invoice_time: 1786377550,
    },
  ];
  const okIssue = await issueInvoice({
    orderId: "IB-1",
    lines: [{ description: "x", quantity: 1, unitPrice: 1, amount: 1 }],
  });
  check("成功時解析出發票號碼", okIssue.invoice.invoiceNumber, "ZA10034112");
  check("成功時解析出隨機碼", okIssue.invoice.randomNumber, "1618");
}

// ── 9. 請求格式 ───────────────────────────────────────────────────────────
console.log("\n[9] 請求格式");
{
  installFetch();
  script = [{ code: 0, msg: "" }];
  await amegoRequest("/json/f0401", { OrderId: "IB-1" });
  const c = calls[0];
  check("POST", c.method, "POST");
  check("打對網址", c.url, "https://invoice-api.amego.tw/json/f0401");
  check(
    "Content-Type 是 form-urlencoded（用 application/json 會得到 code 11）",
    c.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  check("body 的 data 是 JSON 字串", c.fields.data, '{"OrderId":"IB-1"}');
  check("sign 用的是同一個字串", c.fields.sign, amegoSign(c.fields.data, c.fields.time, TEST_KEY));
  checkTrue("time 貼近現在", Math.abs(Number(c.fields.time) - Math.floor(Date.now() / 1000)) <= 2);

  // 作廢只吃陣列（傳物件會得到 3050112）
  installFetch();
  script = [{ code: 0, msg: "" }];
  await voidInvoice({ invoiceNumber: "ZA10034112", reason: "測試作廢" });
  const v = JSON.parse(calls[0].fields.data);
  checkTrue("f0501 的 data 是陣列", Array.isArray(v));
  check("作廢號碼", v[0].CancelInvoiceNumber, "ZA10034112");
  check("作廢日期是 Ymd 8 碼", /^\d{8}$/.test(v[0].CancelDate), true);
  check("作廢日期用台北時區", v[0].CancelDate, taipeiYmd());
  checkTrue(
    "作廢原因會截斷到 20 字以內",
    (() => {
      installFetch();
      script = [{ code: 0, msg: "" }];
      return true;
    })(),
  );
  await voidInvoice({ invoiceNumber: "ZA1", reason: "長".repeat(40) });
  check("原因截斷", JSON.parse(calls[0].fields.data)[0].CancelReason.length, 20);
}

// ── 10. 時鐘 ±60 秒 ───────────────────────────────────────────────────────
// 時鐘漂移的症狀是「全部的發票都開不出來」，而 Amego 回的錯誤訊息（time 錯誤）
// 在 log 裡很容易被當成偶發。作法：正常路徑不多打 /json/time；收到 code 15 才校時、
// 記住 offset、重送一次，之後同一個 instance 的呼叫全部自動帶上 offset。
console.log("\n[10] 時鐘漂移（±60 秒）");
{
  installFetch();
  resetAmegoClockOffset();
  check("初始 offset 為 0", amegoClockOffset(), 0);

  const serverNow = Math.floor(Date.now() / 1000) + 3600; // 伺服器比我們快 1 小時
  script = [
    { code: 15, msg: "time(時間戳記)錯誤" }, // 第一次：用本機時間，被打回
    () =>
      new Response(JSON.stringify({ timestamp: serverNow }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }), // 校時
    { code: 0, msg: "", invoice_number: "ZA10034112" }, // 重送成功
  ];
  const r = await amegoRequest("/json/f0401", { OrderId: "IB-1" });
  checkTrue("code 15 → 校時後重送成功", r.ok);
  check("總共打了 3 次（原請求 + 校時 + 重送）", calls.length, 3);
  check("第 2 次是 GET /json/time", calls[1].url, "https://invoice-api.amego.tw/json/time");
  check("第 2 次不需要簽章", calls[1].method, "GET");
  checkTrue("offset 已記住（約 3600 秒）", Math.abs(amegoClockOffset() - 3600) <= 2);
  checkTrue("重送用的是校正後的時間", Math.abs(Number(calls[2].fields.time) - serverNow) <= 2);

  // offset 記住之後，後續呼叫不再需要校時
  installFetch();
  script = [{ code: 0, msg: "" }];
  await amegoRequest("/json/f0401", { OrderId: "IB-2" });
  check("後續呼叫只打 1 次（不再校時）", calls.length, 1);
  checkTrue("後續呼叫自動帶上 offset", Math.abs(Number(calls[0].fields.time) - serverNow) <= 2);
  checkTrue("amegoNow() 反映 offset", Math.abs(amegoNow() - serverNow) <= 2);

  // 校時本身失敗 → 回報原本的 code 15，不會無限重試
  resetAmegoClockOffset();
  installFetch();
  script = [
    { code: 15, msg: "time(時間戳記)錯誤" },
    () => {
      throw new Error("time endpoint down");
    },
  ];
  const r2 = await amegoRequest("/json/f0401", { OrderId: "IB-3" });
  checkFalse("校時失敗 → 整體失敗", r2.ok);
  check("回報的仍是原本的 code 15", r2.code, 15);
  check("只打了 2 次，不會無限重試", calls.length, 2);
  checkFalse("code 15 被歸類為可重試", isPermanentAmegoError(r2.code));

  // 非時間類的錯誤不會觸發校時
  resetAmegoClockOffset();
  installFetch();
  script = [{ code: 16, msg: "sign(簽名)驗證錯誤" }];
  const r3 = await amegoRequest("/json/f0401", { OrderId: "IB-4" });
  checkFalse("code 16 → 失敗", r3.ok);
  check("code 16 不觸發校時（只打 1 次）", calls.length, 1);
  check("offset 沒有被改動", amegoClockOffset(), 0);
}

// ── 11. 查詢：查無資料不是錯誤 ────────────────────────────────────────────
// 重試路徑靠它判斷「上一次是不是其實已經開成功了」。把 code 71 當成錯誤，重試就會
// 直接重開一張 —— 那正是這整套機制要防的事。
console.log("\n[11] 用 OrderId 反查");
{
  installFetch();
  script = [
    {
      code: 0,
      msg: "",
      data: {
        invoice_number: "ZA10034112",
        random_number: "1618",
        invoice_type: "C0401",
        total_amount: 100,
        wait: [],
      },
    },
  ];
  let q = await findInvoiceByOrderId("IB-1");
  checkTrue("查得到 → ok", q.ok);
  check("回傳發票號碼", q.hit.invoiceNumber, "ZA10034112");
  check("回傳隨機碼", q.hit.randomNumber, "1618");
  checkFalse("沒有待作廢", q.hit.pendingVoid);

  installFetch();
  script = [{ code: AMEGO_CODE_NOT_FOUND, msg: "查無資料" }];
  q = await findInvoiceByOrderId("NO-SUCH");
  checkTrue("code 71 查無資料仍算查詢成功", q.ok);
  check("查無資料 → hit 為 null（代表還沒開過）", q.hit, null);

  installFetch();
  script = [
    {
      code: 0,
      msg: "",
      data: { invoice_number: "ZA10034112", wait: [{ invoice_type: "C0501" }] },
    },
  ];
  q = await findInvoiceByOrderId("IB-1");
  checkTrue("wait 裡有 C0501 → 待作廢", q.hit.pendingVoid);

  installFetch();
  script = [{ code: 16, msg: "sign(簽名)驗證錯誤" }];
  q = await findInvoiceByOrderId("IB-1");
  checkFalse("其他錯誤碼 → 查詢失敗（不可當成「還沒開過」）", q.ok);
}

// ── 12. 未設定時不打網路 ──────────────────────────────────────────────────
console.log("\n[12] 未設定時 fail-safe");
{
  installFetch();
  script = [];
  const saved = process.env.AMEGO_APP_KEY;
  delete process.env.AMEGO_APP_KEY;
  const r = await amegoRequest("/json/f0401", { OrderId: "IB-1" });
  checkFalse("缺金鑰 → 失敗", r.ok);
  check("缺金鑰 → 不發出任何請求", calls.length, 0);
  check("理由說得清楚", r.msg, "amego_not_configured");
  process.env.AMEGO_APP_KEY = saved;
}

// ── 結果 ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(52)}`);
// 機器可讀的收尾，讓 scripts/run-selftests.mjs 能證明「這個檔案真的跑了幾個 case」。
console.log(`##SELFTEST## file=scripts/amego-selftest.mjs pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m\n`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(1);
}
