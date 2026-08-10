#!/usr/bin/env node
// PayUni 加解密自檢 —— 不需要任何真實商店金鑰。
//
// 驗證 src/server/payuni.ts 的 toPlaintext / encryptInfo / hashInfo /
// decryptInfo / verifyHashInfo。
//
// ⚠️ 這支腳本刻意「直接 import 產線那一份 payuni.ts」（靠 Node 原生 TypeScript
// 型別剝離，不經 bundler），不複製一份加解密邏輯 —— 複製品驗過了不代表產線那份
// 是對的。這是在沒有商店憑證的情況下，唯一能證明加解密實作正確的方法。
//
// 執行：node scripts/payuni-selftest.mjs   （或 npm run test:payuni）
// 需求：Node >= 22.6（型別剝離）。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `✗ 需要 Node >= 22.6 才能直接 import TypeScript 原始碼（目前 ${process.versions.node}）`,
  );
  process.exit(1);
}

// ── 測試向量 ──────────────────────────────────────────────────────────────
// KEY/IV/PARAMS 與 HashInfo 取自同團隊 goodday 專案已驗證的 PayUni 實作
// （goodday/scripts/payuni-selftest.mjs，標註為官方文件測試向量）。
// 這裡的價值是「跨專案交叉比對」：alice-store 這份獨立實作若算出同一個
// HashInfo，就證明兩邊對規格的解讀一致，而不是各自對著自己的輸出自我驗證。
const KEY = "12345678901234567890123456789012"; // 32 chars
const IV = "1234567890123456"; // 16 chars
const PARAMS = { MerID: "AAA", MerTradeNO: "BBB", Prod: "商品說明" };
const EXPECT_PLAINTEXT = "MerID=AAA&MerTradeNO=BBB&Prod=%E5%95%86%E5%93%81%E8%AA%AA%E6%98%8E";
const EXPECT_HASHINFO = "E97180D78C8378D64A188D292938B9D2717034F292B626019B01DF160AEFC0B7";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = join(ROOT, "src/server/payuni.ts");

let mod;
try {
  mod = await import(`file://${MODULE_PATH}`);
} catch (err) {
  console.error(`✗ 無法載入 ${MODULE_PATH}`);
  console.error(err);
  process.exit(1);
}

const {
  toPlaintext,
  encryptInfo,
  hashInfo,
  decryptInfo,
  decryptInfoRaw,
  verifyHashInfo,
  buildUppForm,
  payuniReturnUrl,
  payuniNotifyUrl,
  payuniConfigured,
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

function checkThrows(name, fn) {
  try {
    fn();
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}（預期會 throw，實際沒有）`);
  } catch {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  }
}

console.log("\nPayUni 加解密自檢（測試向量，不需真實金鑰）");
console.log(`模組：${MODULE_PATH}\n`);

// ── 1. 明文組成 ───────────────────────────────────────────────────────────
console.log("[1] 明文 = x-www-form-urlencoded query string");
check("toPlaintext 與測試向量逐字相符", toPlaintext(PARAMS), EXPECT_PLAINTEXT);
check(
  "undefined / null 欄位不送出",
  toPlaintext({ A: "1", B: undefined, C: null, D: 2 }),
  "A=1&D=2",
);

// ── 2. encryptInfo ────────────────────────────────────────────────────────
console.log("\n[2] encryptInfo（aes-256-gcm → base64密文:::base64tag → hex）");
const enc = encryptInfo(PARAMS, KEY, IV);
checkTrue("EncryptInfo 是小寫 hex", /^[0-9a-f]+$/.test(enc));
check(
  "hex 解回來含 ::: 分隔且切成 2 段",
  Buffer.from(enc, "hex").toString("utf8").split(":::").length,
  2,
);
// GCM 在 key/iv/明文固定時是決定性的，所以密文可逐字比對。
check("同輸入產生同 EncryptInfo（決定性）", encryptInfo(PARAMS, KEY, IV), enc);

// ── 3. hashInfo（關鍵斷言：跨專案交叉比對）────────────────────────────────
console.log("\n[3] hashInfo = SHA256(HashKey + EncryptInfo + HashIV) 大寫 hex");
const hash = hashInfo(enc, KEY, IV);
check("HashInfo 與測試向量相符", hash, EXPECT_HASHINFO);
checkTrue("HashInfo 是大寫 hex", /^[0-9A-F]{64}$/.test(hash));

// ── 4. round-trip 解密 ────────────────────────────────────────────────────
console.log("\n[4] decryptInfo（hex → ::: 切分 → base64 → AES-GCM 驗 tag 解密）");
check("decryptInfoRaw 還原出原始明文", decryptInfoRaw(enc, KEY, IV), EXPECT_PLAINTEXT);
const parsed = decryptInfo(enc, KEY, IV);
check("decryptInfo.MerID", parsed.MerID, "AAA");
check("decryptInfo.MerTradeNO", parsed.MerTradeNO, "BBB");
check("decryptInfo.Prod（中文正確還原）", parsed.Prod, "商品說明");

// 第二組 round-trip：模擬真實的付款通知欄位。
const notifyParams = {
  MerID: "MER0001",
  MerTradeNo: "IB-202600000042",
  TradeNo: "24081512345678",
  TradeStatus: "1",
  TradeAmt: 1280,
  PaymentType: "1",
  Message: "交易成功",
};
const notifyEnc = encryptInfo(notifyParams, KEY, IV);
const notifyBack = decryptInfo(notifyEnc, KEY, IV);
check("round-trip: MerTradeNo", notifyBack.MerTradeNo, "IB-202600000042");
check("round-trip: TradeAmt（數字轉字串）", notifyBack.TradeAmt, "1280");
check("round-trip: Message（中文）", notifyBack.Message, "交易成功");

// ── 5. 完整性保護：被竄改的密文必須解不開 ────────────────────────────────
console.log("\n[5] GCM authTag 完整性保護");
const raw = Buffer.from(enc, "hex").toString("utf8");
const [ctB64, tagB64] = raw.split(":::");
const ctBuf = Buffer.from(ctB64, "base64");
ctBuf[0] ^= 0xff; // 竄改密文第一個 byte
const tampered = Buffer.from(`${ctBuf.toString("base64")}:::${tagB64}`).toString("hex");
checkThrows("密文被竄改 → decryptInfo throw", () => decryptInfo(tampered, KEY, IV));

const badTag = Buffer.from(
  `${ctB64}:::${Buffer.from("0".repeat(16)).toString("base64")}`,
).toString("hex");
checkThrows("authTag 錯誤 → decryptInfo throw", () => decryptInfo(badTag, KEY, IV));
checkThrows("非法 hex → decryptInfo throw", () => decryptInfo("zzzz", KEY, IV));
checkThrows("缺少 ::: 分隔 → decryptInfo throw", () =>
  decryptInfo(Buffer.from("nope").toString("hex"), KEY, IV),
);

// ── 6. 驗簽 ───────────────────────────────────────────────────────────────
console.log("\n[6] verifyHashInfo（webhook 第一道：先驗簽才解密）");
checkTrue("正確 HashInfo 通過", verifyHashInfo(enc, EXPECT_HASHINFO, KEY, IV));
checkTrue(
  "小寫 HashInfo 也通過（比對前正規化）",
  verifyHashInfo(enc, EXPECT_HASHINFO.toLowerCase(), KEY, IV),
);
check("錯誤 HashInfo 被拒", verifyHashInfo(enc, "A".repeat(64), KEY, IV), false);
check("空 HashInfo 被拒", verifyHashInfo(enc, "", KEY, IV), false);
check("null HashInfo 被拒", verifyHashInfo(enc, null, KEY, IV), false);
check("長度不符的 HashInfo 被拒", verifyHashInfo(enc, "ABC", KEY, IV), false);
// 換一把金鑰算出來的簽章不能通過 —— 這條就是 webhook 的偽造防線。
const OTHER_KEY = "abcdefghijklmnopqrstuvwxyz012345";
check(
  "用別把金鑰簽的 HashInfo 被拒",
  verifyHashInfo(enc, hashInfo(enc, OTHER_KEY, IV), KEY, IV),
  false,
);

// ── 7. 金鑰長度守門 ───────────────────────────────────────────────────────
console.log("\n[7] 金鑰長度檢查（32 / 16 bytes）");
checkThrows("HashKey 長度錯誤 → throw", () => encryptInfo(PARAMS, "tooshort", IV));
checkThrows("HashIV 長度錯誤 → throw", () => encryptInfo(PARAMS, KEY, "short"));
checkThrows("HashIV 用 GCM 慣例的 12 bytes → throw", () =>
  encryptInfo(PARAMS, KEY, "123456789012"),
);

// ── 8. UPP 表單組成（用假金鑰，不打任何網路） ─────────────────────────────
console.log("\n[8] buildUppForm（{ action, fields }，由前端 POST）");
process.env.PAYUNI_MER_ID = "TESTMER01";
process.env.PAYUNI_HASH_KEY = KEY;
process.env.PAYUNI_HASH_IV = IV;
process.env.PAYUNI_WEBHOOK_SECRET = "selftest-secret";
process.env.SITE_URL = "https://example.test";
delete process.env.PAYUNI_SANDBOX; // 未設定 → 沙盒（fail-safe）

checkTrue("payuniConfigured() 四把齊全時為 true", payuniConfigured());

const form = buildUppForm({
  merTradeNo: "IB-202600000042",
  amount: 1280,
  prodDesc: "小時光書店訂單",
  returnUrl: payuniReturnUrl("a".repeat(48)),
});
check("action 指向沙盒 UPP", form.action, "https://sandbox-api.payuni.com.tw/api/upp");
check("Version 欄位", form.fields.Version, "2.0");
check("MerID 欄位", form.fields.MerID, "TESTMER01");
checkTrue("EncryptInfo 是 hex", /^[0-9a-f]+$/.test(form.fields.EncryptInfo));
check(
  "HashInfo 與 EncryptInfo 對得起來",
  form.fields.HashInfo,
  hashInfo(form.fields.EncryptInfo, KEY, IV),
);
check("四個欄位剛好", Object.keys(form.fields).sort().join(","), "EncryptInfo,HashInfo,MerID,Version");

// 表單內容解回來確認金額與導回網址真的進去了。
const inner = decryptInfo(form.fields.EncryptInfo, KEY, IV);
check("TradeAmt 為訂單金額", inner.TradeAmt, "1280");
check("MerTradeNo = order_no", inner.MerTradeNo, "IB-202600000042");
check(
  "ReturnURL 帶著 public_token（gateway 不會幫我們帶回來）",
  inner.ReturnURL,
  `https://example.test/checkout/complete?token=${"a".repeat(48)}`,
);
check(
  "NotifyURL 帶著 webhook 密鑰",
  inner.NotifyURL,
  "https://example.test/api/webhooks/payuni?k=selftest-secret",
);
check("只開信用卡", inner.Credit, "1");

checkThrows("MerTradeNo 含非法字元 → throw", () =>
  buildUppForm({ merTradeNo: "IB/2026#0001", amount: 100, prodDesc: "x", returnUrl: "https://e.test" }),
);
checkThrows("金額為 0 → throw", () =>
  buildUppForm({ merTradeNo: "IB-1", amount: 0, prodDesc: "x", returnUrl: "https://e.test" }),
);
checkThrows("金額為負 → throw", () =>
  buildUppForm({ merTradeNo: "IB-1", amount: -5, prodDesc: "x", returnUrl: "https://e.test" }),
);

// ── 9. 設定失誤時必須 fail-safe 關閉刷卡 ──────────────────────────────────
// 這一組是「客人付了錢、我們卻收不到通知」那個災難的守門測試，見 payuniConfigured()。
console.log("\n[9] 設定失誤 → 關閉刷卡（fail-safe）");
// NotifyURL 只接受 80/443：本機 dev port 應該回 null（而不是送一個打不進來的網址）。
process.env.SITE_URL = "http://localhost:8080";
check("非 80/443 port → payuniNotifyUrl() 回 null", payuniNotifyUrl(), null);
check("非 80/443 port → payuniConfigured() 為 false", payuniConfigured(), false);
delete process.env.SITE_URL;
check("SITE_URL 未設定（退回 localhost）→ payuniConfigured() 為 false", payuniConfigured(), false);
process.env.SITE_URL = "https://example.test";
checkTrue("SITE_URL 正確時恢復可用", payuniConfigured());
delete process.env.PAYUNI_WEBHOOK_SECRET;
check("缺 webhook secret → payuniNotifyUrl() 回 null", payuniNotifyUrl(), null);
check("缺 webhook secret → payuniConfigured() 為 false", payuniConfigured(), false);

// ── 結果 ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(52)}`);
if (fail === 0) {
  console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m\n`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(1);
}
