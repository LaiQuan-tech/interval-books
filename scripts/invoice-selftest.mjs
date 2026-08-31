#!/usr/bin/env node
// 結帳發票欄位自檢 —— 不打網路，不需要任何憑證，也不碰資料庫。
//
// 這支驗三件事，每一件都是「錯了不會有人立刻發現」的那種：
//
//   1. **統編檢核碼的兩份實作不會漂移。** src/lib/invoice-format.ts（瀏覽器與 server
//      function 共用）與 src/server/amego.ts（開票時的最後一關）各有一份 isValidTaxId。
//      兩份是刻意的：amego.ts 不 import 任何專案模組，那是 amego-selftest 能直接驗
//      產線程式碼的前提；而 amego.ts 不能被瀏覽器 import（vite client
//      importProtection）。刻意的重複要有守門的東西，不然它就只是重複 —— 這裡拿
//      同一組向量同時餵給兩份，答案不一樣就紅。
//
//   2. **發票欄位不影響金額。** checkoutPayloadSchema 是唯一的入口驗證，而發票是
//      「一個看起來很適合放金額的地方」（稅額、總計都是發票上真的有的欄位）。這裡
//      直接拿被塞了 total / subtotal / shippingFee / price 的 payload 去 parse，
//      斷言那些鍵一個都活不下來。Phase A/B 的竄改實測驗的是同一條規則的執行期版本，
//      這一份是它在 CI 裡的常駐版本。
//
//   3. **錯誤訊息掛在正確的欄位上。** zod 的 superRefine 如果忘了給 path，訊息會變成
//      表單層的錯誤 —— react-hook-form 找不到欄位可以掛，畫面上什麼都不會出現，而
//      handleSubmit 仍然拒絕送出。使用者看到的是「按了沒反應」，最難查的一種。
//
// ⚠️ 這支腳本直接 import 產線原始碼（Node 原生型別剝離），不複製任何一份實作。
// src/lib/checkout.ts 用 `@/…` 匯入，Node 不認得那個別名，所以下面註冊了一個
// 解析 hook 把它轉回檔案路徑 —— 只影響這個測試行程，產線程式碼一個字都不用改。
//
// 執行：node scripts/invoice-selftest.mjs
// 需求：Node >= 22.6（型別剝離）。

import { register } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `✗ 需要 Node >= 22.6 才能直接 import TypeScript 原始碼（目前 ${process.versions.node}）`,
  );
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── `@/` 別名的解析 hook ──────────────────────────────────────────────────
// tsconfig 的 paths 是給 TypeScript 與 bundler 看的，Node 不讀它。沒有這一段，
// 任何 import 到 `@/lib/invoice-format` 的產線模組都載不起來，這支測試就只能改去
// 驗一份複製品 —— 那等於沒驗。
{
  const hook = `
    const ROOT = ${JSON.stringify(ROOT)};
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith("@/")) {
        const rest = specifier.slice(2);
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        for (const cand of [rest, rest + ".ts", rest + ".tsx", rest + "/index.ts"]) {
          const abs = join(ROOT, "src", cand);
          if (existsSync(abs)) return { url: pathToFileURL(abs).href, shortCircuit: true };
        }
      }
      return next(specifier, context);
    }
  `;
  register("data:text/javascript," + encodeURIComponent(hook), pathToFileURL(ROOT + "/"));
}

const FORMAT_PATH = join(ROOT, "src/lib/invoice-format.ts");
const AMEGO_PATH = join(ROOT, "src/server/amego.ts");
const CHECKOUT_PATH = join(ROOT, "src/lib/checkout.ts");
for (const p of [FORMAT_PATH, AMEGO_PATH, CHECKOUT_PATH]) {
  if (!existsSync(p)) {
    console.error(`✗ 找不到 ${p} —— 檔案被搬走了，這支測試驗的東西已經不在那裡`);
    process.exit(1);
  }
}

// amego.ts 會讀環境變數。設好只是為了讓它與 amego-selftest 從同一個起點跑；
// 這支測試不會發出任何請求。
process.env.AMEGO_INVOICE_BAN = "12345678";
process.env.AMEGO_APP_KEY = "sHeq7t8G1wiQvhAuIM27";

const format = await import(pathToFileURL(FORMAT_PATH).href);
const amego = await import(pathToFileURL(AMEGO_PATH).href);
const checkout = await import(pathToFileURL(CHECKOUT_PATH).href);

const {
  CARRIER_MOBILE,
  CARRIER_NPC,
  DEFAULT_INVOICE_CHOICE,
  INVOICE_TYPES,
  isValidCarrier,
  isValidLoveCode,
  isValidMobileCarrier,
  isValidNpcCarrier,
  isValidTaxId,
  normalizeInvoiceChoice,
} = format;
const { checkoutFormSchema, checkoutPayloadSchema } = checkout;

// ── 迷你測試框架 ──────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        expected: ${e}\n        actual:   ${a}`);
  }
}
const checkTrue = (n, a) => check(n, a === true, true);
const checkFalse = (n, a) => check(n, a === false, true);

const zh = (m) => m.zh;

// ── 1. 統一編號檢核碼 ─────────────────────────────────────────────────────
console.log("\n[1] 統一編號檢核碼（財政部規則）");
{
  // 真實存在的公司統編，用來確認這不是一個「什麼都說對」的函式。
  checkTrue("04595257（台積電）有效", isValidTaxId("04595257"));
  checkTrue("22099131（中華電信）有效", isValidTaxId("22099131"));
  checkTrue("53212539 有效", isValidTaxId("53212539"));
  // 第 7 碼為 7 的特例：加權和 39 不是 5 的倍數，+1 之後才是。
  checkTrue("12345675 有效（第 7 碼為 7 的特例）", isValidTaxId("12345675"));

  // ⚠️ 12345678 是 Amego 文件公開的測試「賣方」統編，而它通不過檢核碼。
  // 這一條同時守著 src/server/amego.ts 檔頭那句警告：這個函式只能用來驗買方統編，
  // 拿去驗 AMEGO_INVOICE_BAN 會讓整個測試環境開不了票。
  checkFalse("12345678 無效（Amego 的測試賣方統編）", isValidTaxId("12345678"));
  checkFalse("12345672 無效", isValidTaxId("12345672"));
  checkFalse("12345677 無效", isValidTaxId("12345677"));

  checkFalse("7 碼太短", isValidTaxId("1234567"));
  checkFalse("9 碼太長", isValidTaxId("123456755"));
  checkFalse("含英文字母", isValidTaxId("1234567A"));
  checkFalse("空字串", isValidTaxId(""));
  checkFalse("null", isValidTaxId(null));
  checkFalse("undefined", isValidTaxId(undefined));
  checkTrue("前後空白會被 trim", isValidTaxId("  04595257  "));
  checkFalse("全形數字不算數字", isValidTaxId("０４５９５２５７"));
}

// ── 2. 兩份實作的對拍（漂移守門）────────────────────────────────────────
console.log("\n[2] 與 src/server/amego.ts 的 isValidTaxId 對拍");
{
  // 固定種子的偽亂數：每次跑的向量完全一樣，紅了之後重跑一定重現得出來。
  let seed = 20260811;
  const nextInt = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };

  const vectors = [];
  // 系統性：所有第 7 碼為 7 的形狀（特例分支必須被踩到）
  for (let i = 0; i < 600; i += 1) {
    const head = String(nextInt() % 1000000).padStart(6, "0");
    vectors.push(`${head}7${nextInt() % 10}`);
  }
  // 一般亂數
  for (let i = 0; i < 20000; i += 1) {
    vectors.push(String(nextInt() % 100000000).padStart(8, "0"));
  }
  // 非數字／長度不對的輸入也要一起對拍：兩份的「拒絕」條件也可能漂移。
  vectors.push("", " ", "1234567", "123456789", "1234567A", "abcdefgh", "  04595257  ");

  let disagree = 0;
  let firstDisagreement = null;
  let validCount = 0;
  for (const v of vectors) {
    const mine = isValidTaxId(v);
    const theirs = amego.isValidTaxId(v);
    if (mine) validCount += 1;
    if (mine !== theirs) {
      disagree += 1;
      if (firstDisagreement === null) firstDisagreement = { v, mine, theirs };
    }
  }
  check(`${vectors.length} 組向量，兩份實作的分歧數`, disagree, 0);
  if (firstDisagreement) console.log(`        第一個分歧：${JSON.stringify(firstDisagreement)}`);
  // 沒有這一條的話，「兩份都永遠回 false」也會讓上面那條通過。
  checkTrue(`向量裡真的有有效的統編（${validCount} 個）`, validCount > 1000);
  checkTrue(`向量裡真的有無效的統編`, vectors.length - validCount > 1000);
}

// ── 3. 手機條碼載具 ───────────────────────────────────────────────────────
console.log("\n[3] 手機條碼載具（/ 開頭共 8 碼）");
{
  checkTrue("/ABC1234 有效", isValidMobileCarrier("/ABC1234"));
  checkTrue("/1234567 有效", isValidMobileCarrier("/1234567"));
  // 財政部的字集含 + - .，用 [0-9A-Z]{7} 會把真的印在條碼上的載具擋掉。
  checkTrue("/AB+12.- 有效（+ - . 都在字集內）", isValidMobileCarrier("/AB+12.-"));
  checkFalse("沒有 / 開頭", isValidMobileCarrier("ABC12345"));
  checkFalse("只有 7 碼", isValidMobileCarrier("/ABC123"));
  checkFalse("9 碼太長", isValidMobileCarrier("/ABC12345"));
  checkFalse("小寫不合格（條碼上是大寫）", isValidMobileCarrier("/abc1234"));
  checkFalse("空字串", isValidMobileCarrier(""));
  checkFalse("null", isValidMobileCarrier(null));
  checkTrue("前後空白會被 trim", isValidMobileCarrier("  /ABC1234 "));
}

// ── 4. 自然人憑證載具 ─────────────────────────────────────────────────────
console.log("\n[4] 自然人憑證載具（2 大寫英文 + 14 數字）");
{
  checkTrue("AB12345678901234 有效", isValidNpcCarrier("AB12345678901234"));
  checkFalse("只有 13 個數字", isValidNpcCarrier("AB1234567890123"));
  checkFalse("15 個數字太長", isValidNpcCarrier("AB123456789012345"));
  checkFalse("小寫字母", isValidNpcCarrier("ab12345678901234"));
  checkFalse("只有 1 個字母", isValidNpcCarrier("A123456789012345"));
  checkFalse("3 個字母", isValidNpcCarrier("ABC2345678901234"));
  checkFalse("空字串", isValidNpcCarrier(""));
}

// ── 5. isValidCarrier 依類型分派 ──────────────────────────────────────────
console.log("\n[5] isValidCarrier 依載具類型挑規則");
{
  checkTrue("3J0002 + 手機條碼", isValidCarrier(CARRIER_MOBILE, "/ABC1234"));
  checkFalse(
    "3J0002 + 自然人憑證格式（張冠李戴）",
    isValidCarrier(CARRIER_MOBILE, "AB12345678901234"),
  );
  checkTrue("CQ0001 + 自然人憑證", isValidCarrier(CARRIER_NPC, "AB12345678901234"));
  checkFalse("CQ0001 + 手機條碼格式（張冠李戴）", isValidCarrier(CARRIER_NPC, "/ABC1234"));
  checkFalse("不認得的載具類型一律不放行", isValidCarrier("XX0000", "/ABC1234"));
  checkFalse("類型空白 → 沒有號碼可驗", isValidCarrier("", "/ABC1234"));
  checkFalse("類型 null", isValidCarrier(null, "/ABC1234"));
}

// ── 6. 愛心碼 ─────────────────────────────────────────────────────────────
console.log("\n[6] 愛心碼（3–7 位數字）");
{
  checkTrue("25885（家扶）有效", isValidLoveCode("25885"));
  checkTrue("3 位數是下限", isValidLoveCode("001"));
  checkTrue("7 位數是上限", isValidLoveCode("1234567"));
  checkFalse("2 位數太短", isValidLoveCode("12"));
  checkFalse("8 位數太長", isValidLoveCode("12345678"));
  checkFalse("含英文字母", isValidLoveCode("2588A"));
  checkFalse("空字串", isValidLoveCode(""));
  checkFalse("null", isValidLoveCode(null));
}

// ── 7. normalizeInvoiceChoice —— 類型收斂 ────────────────────────────────
console.log("\n[7] normalizeInvoiceChoice：不屬於該類型的欄位一律不留");
{
  check("undefined → 預設個人無載具", normalizeInvoiceChoice(undefined), DEFAULT_INVOICE_CHOICE);
  check("null → 預設個人無載具", normalizeInvoiceChoice(null), DEFAULT_INVOICE_CHOICE);
  check("空物件 → 預設個人無載具", normalizeInvoiceChoice({}), DEFAULT_INVOICE_CHOICE);
  check(
    "不認得的 type → 退回 personal",
    normalizeInvoiceChoice({ type: "corporate" }),
    DEFAULT_INVOICE_CHOICE,
  );

  check(
    "company 帶著載具與愛心碼 → 只留統編與抬頭",
    normalizeInvoiceChoice({
      type: "company",
      taxId: "04595257",
      companyTitle: "台灣積體電路製造股份有限公司",
      carrierType: CARRIER_MOBILE,
      carrierNumber: "/ABC1234",
      loveCode: "25885",
    }),
    {
      type: "company",
      taxId: "04595257",
      companyTitle: "台灣積體電路製造股份有限公司",
      carrierType: null,
      carrierNumber: null,
      loveCode: null,
    },
  );
  check(
    "company 但統編檢核碼錯 → 整個退回個人發票",
    normalizeInvoiceChoice({ type: "company", taxId: "12345678", companyTitle: "測試" }),
    DEFAULT_INVOICE_CHOICE,
  );
  check(
    "company 但沒填統編 → 退回個人發票",
    normalizeInvoiceChoice({ type: "company", companyTitle: "測試" }),
    DEFAULT_INVOICE_CHOICE,
  );

  check(
    "donate 帶著統編 → 只留愛心碼",
    normalizeInvoiceChoice({ type: "donate", loveCode: "25885", taxId: "04595257" }),
    {
      type: "donate",
      taxId: null,
      companyTitle: null,
      carrierType: null,
      carrierNumber: null,
      loveCode: "25885",
    },
  );
  check(
    "donate 但愛心碼格式錯 → 退回個人發票",
    normalizeInvoiceChoice({ type: "donate", loveCode: "1" }),
    DEFAULT_INVOICE_CHOICE,
  );

  check(
    "personal + 手機條碼",
    normalizeInvoiceChoice({
      type: "personal",
      carrierType: CARRIER_MOBILE,
      carrierNumber: "/abc1234",
    }),
    {
      type: "personal",
      taxId: null,
      companyTitle: null,
      carrierType: CARRIER_MOBILE,
      carrierNumber: "/ABC1234",
      loveCode: null,
    },
  );
  check(
    "personal 帶著統編 → 統編不會留下來",
    normalizeInvoiceChoice({ type: "personal", taxId: "04595257" }),
    DEFAULT_INVOICE_CHOICE,
  );
  check(
    "personal + 載具號碼格式錯 → 丟掉載具，發票照開",
    normalizeInvoiceChoice({ type: "personal", carrierType: CARRIER_MOBILE, carrierNumber: "ABC" }),
    DEFAULT_INVOICE_CHOICE,
  );
  check(
    "抬頭超過 60 字會被截斷",
    normalizeInvoiceChoice({ type: "company", taxId: "04595257", companyTitle: "股".repeat(100) })
      .companyTitle.length,
    60,
  );
  checkTrue(
    "回傳的鍵永遠是固定那六個",
    INVOICE_TYPES.every(
      (t) =>
        JSON.stringify(Object.keys(normalizeInvoiceChoice({ type: t })).sort()) ===
        JSON.stringify([
          "carrierNumber",
          "carrierType",
          "companyTitle",
          "loveCode",
          "taxId",
          "type",
        ]),
    ),
  );
}

// ── 8. 發票欄位不影響金額 ─────────────────────────────────────────────────
console.log("\n[8] checkoutPayloadSchema：發票欄位帶不動任何金額");
{
  const base = {
    customerName: "測試",
    customerEmail: "test@example.com",
    customerPhone: "0912345678",
    shippingMethod: "home",
    address: {
      recipient: "測試",
      phone: "0912345678",
      city: "台北市",
      street: "測試路 1 號",
    },
    items: [{ productId: "11111111-1111-4111-8111-111111111111", quantity: 1 }],
    locale: "zh",
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
  };

  const MONEY_KEYS = [
    "total",
    "subtotal",
    "shippingFee",
    "discount",
    "price",
    "unitPrice",
    "amount",
    "taxAmount",
    "salesAmount",
  ];

  // 根層級注入
  const rootTampered = { ...base };
  for (const k of MONEY_KEYS) rootTampered[k] = 1;
  const rootParsed = checkoutPayloadSchema.safeParse(rootTampered);
  checkTrue("塞了金額欄位的 payload 仍然 parse 得過（不是靠報錯擋的）", rootParsed.success);
  check(
    "根層級的金額欄位全部被丟掉",
    MONEY_KEYS.filter((k) => k in (rootParsed.data ?? {})),
    [],
  );

  // 發票物件裡注入 —— 稅額、總計都是「發票上真的有」的欄位，最容易被當成合理
  const invoiceTampered = {
    ...base,
    invoice: { type: "company", taxId: "04595257", total: 1, taxAmount: 0, salesAmount: 1 },
  };
  const invParsed = checkoutPayloadSchema.safeParse(invoiceTampered);
  checkTrue("發票物件裡塞金額也 parse 得過", invParsed.success);
  check(
    "發票物件裡的金額欄位全部被丟掉",
    MONEY_KEYS.filter((k) => k in (invParsed.data?.invoice ?? {})),
    [],
  );
  check("留下來的發票欄位只有該有的那些", Object.keys(invParsed.data?.invoice ?? {}).sort(), [
    "taxId",
    "type",
  ]);
  check(
    "品項只帶得動 productId 與 quantity",
    Object.keys(invParsed.data?.items?.[0] ?? {}).sort(),
    ["productId", "quantity"],
  );

  // 每一個品項也不能夾帶單價
  const itemTampered = {
    ...base,
    items: [
      { productId: "11111111-1111-4111-8111-111111111111", quantity: 1, unitPrice: 1, subtotal: 1 },
    ],
  };
  const itemParsed = checkoutPayloadSchema.safeParse(itemTampered);
  check(
    "品項層級的金額欄位也被丟掉",
    MONEY_KEYS.filter((k) => k in (itemParsed.data?.items?.[0] ?? {})),
    [],
  );

  // schema 本身不可以有金額形狀的鍵。上面驗的是「這幾個名字」，這一條驗的是
  // 「未來有人加了一個新的金額欄位」——名字沒對到清單也會被抓出來。
  const shapeKeys = Object.keys(checkoutPayloadSchema.shape ?? {});
  check(
    "checkoutPayloadSchema 沒有任何金額形狀的欄位",
    shapeKeys.filter((k) => /total|price|amount|fee|discount|subtotal|cost/i.test(k)),
    [],
  );
  // 沒有這一條的話，schema 被改成空的也會讓上面那條通過。
  checkTrue(`schema 真的有欄位（${shapeKeys.length} 個）`, shapeKeys.length >= 9);
}

// ── 9. 沒送 invoice 的舊版前端仍然結得了帳 ────────────────────────────────
console.log("\n[9] 向後相容：payload 沒有 invoice 欄位");
{
  const noInvoice = {
    customerName: "測試",
    customerEmail: "test@example.com",
    customerPhone: "0912345678",
    shippingMethod: "pickup",
    items: [{ productId: "11111111-1111-4111-8111-111111111111", quantity: 1 }],
    locale: "zh",
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
  };
  const parsed = checkoutPayloadSchema.safeParse(noInvoice);
  checkTrue("沒有 invoice 欄位仍然 parse 得過", parsed.success);
  check(
    "normalize 之後是預設的個人發票",
    normalizeInvoiceChoice(parsed.data?.invoice),
    DEFAULT_INVOICE_CHOICE,
  );
}

// ── 10. 錯誤訊息掛在正確的欄位路徑上 ──────────────────────────────────────
console.log("\n[10] 驗證錯誤的 path（決定訊息會不會出現在欄位旁邊）");
{
  const schema = checkoutFormSchema({ t: zh, requireAddress: false });
  const base = {
    customerName: "測試",
    customerEmail: "test@example.com",
    customerPhone: "0912345678",
    shippingMethod: "pickup",
  };
  const pathsOf = (invoice) => {
    const r = schema.safeParse({ ...base, invoice });
    return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
  };
  const messageOf = (invoice) => {
    const r = schema.safeParse({ ...base, invoice });
    return r.success ? null : r.error.issues[0].message;
  };

  check("公司但統編是空的 → invoice.taxId", pathsOf({ type: "company", taxId: "" }), [
    "invoice.taxId",
  ]);
  check("公司但統編只有 7 碼 → invoice.taxId", pathsOf({ type: "company", taxId: "1234567" }), [
    "invoice.taxId",
  ]);
  check("公司但檢核碼錯 → invoice.taxId", pathsOf({ type: "company", taxId: "12345678" }), [
    "invoice.taxId",
  ]);
  // 「8 碼」與「檢核碼」是兩則不同的訊息：客人打滿 8 碼還看到「請輸入 8 碼」會以為
  // 是自己數錯了，真正的問題是其中一碼打錯。
  checkTrue(
    "碼數不對與檢核碼不對是不同的訊息",
    messageOf({ type: "company", taxId: "1234567" }) !==
      messageOf({ type: "company", taxId: "12345678" }),
  );
  checkTrue(
    "檢核碼的訊息說得出「檢核碼」",
    String(messageOf({ type: "company", taxId: "12345678" })).includes("檢核碼"),
  );

  check("捐贈但愛心碼格式錯 → invoice.loveCode", pathsOf({ type: "donate", loveCode: "1" }), [
    "invoice.loveCode",
  ]);
  check(
    "個人選了手機條碼但號碼錯 → invoice.carrierNumber",
    pathsOf({ type: "personal", carrierType: CARRIER_MOBILE, carrierNumber: "ABC" }),
    ["invoice.carrierNumber"],
  );
  check(
    "個人選了自然人憑證但號碼錯 → invoice.carrierNumber",
    pathsOf({ type: "personal", carrierType: CARRIER_NPC, carrierNumber: "/ABC1234" }),
    ["invoice.carrierNumber"],
  );
  check("個人不選載具 → 沒有任何錯誤", pathsOf({ type: "personal", carrierType: "" }), []);
  check("公司統編正確 → 沒有任何錯誤", pathsOf({ type: "company", taxId: "04595257" }), []);
  check("捐贈愛心碼正確 → 沒有任何錯誤", pathsOf({ type: "donate", loveCode: "25885" }), []);

  // 語言：訊息由呼叫端的 t 決定，不是寫死中文。
  const en = checkoutFormSchema({ t: (m) => m.en, requireAddress: false });
  const enResult = en.safeParse({ ...base, invoice: { type: "company", taxId: "12345678" } });
  checkTrue(
    "英文介面拿到英文訊息",
    !enResult.success && /check digit/i.test(enResult.error.issues[0].message),
  );
  const ja = checkoutFormSchema({ t: (m) => m.ja, requireAddress: false });
  const jaResult = ja.safeParse({ ...base, invoice: { type: "company", taxId: "12345678" } });
  checkTrue(
    "日文介面拿到日文訊息",
    !jaResult.success && /チェックディジット/.test(jaResult.error.issues[0].message),
  );
}

// ── 結果 ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(52)}`);
// 機器可讀的收尾，讓 scripts/run-selftests.mjs 能證明「這個檔案真的跑了幾個 case」。
console.log(`##SELFTEST## file=scripts/invoice-selftest.mjs pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m\n`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(1);
}
