#!/usr/bin/env node
/**
 * 儀表板營收的自檢。
 *
 * ── 為什麼這一支存在 ──────────────────────────────────────────────────────
 * 一個算錯的營收數字比沒有數字更糟：它看起來完全正常，而且**不會有人發現**。少算
 * 了早上八點以前的訂單、多算了一筆沙盒測試單、或者把線上訂單從門市那一側再加一次
 * ——每一種錯誤在畫面上都只是一個略有不同的整數。
 *
 * 所以這一支直接 import **產線的** src/lib/admin/revenue.ts（Node 原生型別剝離，
 * 不經 bundler、不經 @/ alias），驗的是真的那份程式，不是抄過去的副本。
 *
 * 執行：node scripts/dashboard-revenue-selftest.mjs（或 npm test）
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/dashboard-revenue-selftest.mjs";

let pass = 0;
let fail = 0;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function check(label, actual, expected, hint) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
    if (hint) console.log(red(`      ${hint}`));
  }
}

function checkTrue(label, value, hint) {
  check(label, value === true, true, hint);
}

console.log("═══ 儀表板營收自檢 ═══");

console.log("\n[0] 載入產線模組");
let R;
try {
  R = await import(join(ROOT, "src/lib/admin/revenue.ts"));
  pass += 1;
  console.log(green("  ✓ 載入 src/lib/admin/revenue.ts"));
} catch (err) {
  fail += 1;
  console.log(red(`  ✗ 無法載入 src/lib/admin/revenue.ts：${err}`));
  console.log(`\n${"─".repeat(52)}`);
  console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
console.log("\n[1] 台北日界 —— 少算早上八點以前的訂單是最容易發生的錯");
// -----------------------------------------------------------------------------
// 台北是 UTC+8 且沒有日光節約。UTC 16:00 起就是台北的隔天。
check("UTC 9/7 20:00 → 台北 9/8", R.taipeiDayOf("2026-09-07T20:00:00Z"), "2026-09-08");
check("UTC 9/7 16:00 → 台北 9/8（日界正上）", R.taipeiDayOf("2026-09-07T16:00:00Z"), "2026-09-08");
check(
  "UTC 9/7 15:59 → 台北 9/7（日界前一分鐘）",
  R.taipeiDayOf("2026-09-07T15:59:00Z"),
  "2026-09-07",
);
check("UTC 9/7 00:00 → 台北 9/7", R.taipeiDayOf("2026-09-07T00:00:00Z"), "2026-09-07");
// 帶時區偏移的字串也要得到同一個答案。
check("+08:00 的字串同樣正確", R.taipeiDayOf("2026-09-08T04:00:00+08:00"), "2026-09-08");

// -----------------------------------------------------------------------------
console.log("\n[2] 哪些訂單算數");
// -----------------------------------------------------------------------------
const paid = (over) => ({
  total: 1000,
  paid_at: "2026-09-07T02:00:00Z",
  payment_method: "card",
  payment_status: "paid",
  ...over,
});

checkTrue("刷卡已付款：算", R.isRealisedRevenue(paid({})));
checkTrue(
  "payment_method=null（由店家聯繫付款）：算",
  R.isRealisedRevenue(paid({ payment_method: null })),
);
checkTrue("匯款已付款：算", R.isRealisedRevenue(paid({ payment_method: "transfer" })));
checkTrue(
  "免費訂單：算（金額 0，無害）",
  R.isRealisedRevenue(paid({ payment_method: "free", total: 0 })),
);
check("沙盒測試單：不算", R.isRealisedRevenue(paid({ payment_method: "test_paid" })), false);
check(
  "payment_status=pending：不算",
  R.isRealisedRevenue(paid({ payment_status: "pending" })),
  false,
);
check("已退款：不算", R.isRealisedRevenue(paid({ payment_status: "refunded" })), false);
check("沒有 paid_at：不算（無從分桶）", R.isRealisedRevenue(paid({ paid_at: null })), false);

// 🔴 這一條是回歸測試：archived_at 只是後台列表的隱藏（0035），已付款訂單刪不掉、
//    只能封存。拿它當過濾條件會讓已實現的營收隨著封存一筆一筆消失，而且不會報錯。
checkTrue(
  "已封存但已付款：仍然算（archived_at 不該影響營收）",
  R.isRealisedRevenue(paid({ archived_at: "2026-09-07T05:00:00Z" })),
);

// -----------------------------------------------------------------------------
console.log("\n[3] 🔴 線上訂單不可以從門市那一側再被加一次");
// -----------------------------------------------------------------------------
// 線上訂單付款後，commit_inventory_reservations()（0011 §7）會往 inv.sales 插一筆
// channel='online' 的列。把整個 inv_pos_sales 加總就會重複計算。
check("只認 channel='pos'", R.POS_REVENUE_CHANNEL, "pos");

const orders = [paid({ total: 1000, paid_at: "2026-09-07T02:00:00Z" })];
const posRows = [
  { amount: 1000, sale_date: "2026-09-07", channel: "online" }, // ← 上面那筆訂單的鏡像
  { amount: 300, sale_date: "2026-09-07", channel: "pos" },
];
const s = R.summariseRange(orders, posRows, "2026-09-07", "2026-09-07");
check("線上 1000", s.online, 1000);
check("門市 300（online 那一列被擋掉）", s.pos, 300);
check("總計 1300，不是 2300", s.total, 1300, "重複計算了 channel='online' 的鏡像列");

// -----------------------------------------------------------------------------
console.log("\n[4] 區間邊界含頭含尾");
// -----------------------------------------------------------------------------
checkTrue("區間第一天算在內", R.withinRange("2026-09-01", "2026-09-01", "2026-09-30"));
checkTrue("區間最後一天算在內", R.withinRange("2026-09-30", "2026-09-01", "2026-09-30"));
check("區間前一天不算", R.withinRange("2026-08-31", "2026-09-01", "2026-09-30"), false);
check("區間後一天不算", R.withinRange("2026-10-01", "2026-09-01", "2026-09-30"), false);

// 台北日界 + 區間邊界疊在一起：UTC 8/31 20:00 的訂單屬於台北 9/1，要算進九月。
const septOnly = R.summariseRange(
  [paid({ total: 500, paid_at: "2026-08-31T20:00:00Z" })],
  [],
  "2026-09-01",
  "2026-09-30",
);
check("UTC 8/31 晚上的訂單算進九月（台北已經 9/1）", septOnly.online, 500);

// -----------------------------------------------------------------------------
console.log("\n[5] 日期運算");
// -----------------------------------------------------------------------------
check("月初", R.startOfMonth("2026-09-07"), "2026-09-01");
check("年初", R.startOfYear("2026-09-07"), "2026-01-01");
check("跨月往前", R.addDays("2026-09-01", -1), "2026-08-31");
check("跨年往前", R.addDays("2026-01-01", -1), "2025-12-31");
check("閏年 2/29", R.addDays("2028-02-28", 1), "2028-02-29");
check("平年沒有 2/29", R.addDays("2026-02-28", 1), "2026-03-01");
check("30 天區間含今天共 30 個桶", R.daysBetween("2026-08-09", "2026-09-07").length, 30);
check("趨勢區間", R.dashboardRanges("2026-09-07").trend, { from: "2026-08-09", to: "2026-09-07" });
check("今日區間", R.dashboardRanges("2026-09-07").today, { from: "2026-09-07", to: "2026-09-07" });

// -----------------------------------------------------------------------------
console.log("\n[6] 筆數：免費訂單不混進「幾筆訂單」");
// -----------------------------------------------------------------------------
const mixed = R.summariseRange(
  [
    paid({ total: 1000 }),
    paid({ total: 0, payment_method: "free" }),
    paid({ total: 9999, payment_method: "test_paid" }),
  ],
  [{ amount: 250, sale_date: "2026-09-07", channel: "pos" }],
  "2026-09-07",
  "2026-09-07",
);
check("線上金額只有 1000（測試單被排除、免費單是 0）", mixed.online, 1000);
check("付費訂單 1 筆", mixed.onlineOrders, 1);
check("免費訂單另外數", mixed.freeOrders, 1);
check("門市 1 筆 250", [mixed.posSales, mixed.pos], [1, 250]);

// -----------------------------------------------------------------------------
console.log("\n[7] 每日分桶：沒有營收的那一天要是 0，不是被跳過");
// -----------------------------------------------------------------------------
const buckets = R.bucketByDay(
  [paid({ total: 700, paid_at: "2026-09-03T02:00:00Z" })],
  [{ amount: 100, sale_date: "2026-09-05", channel: "pos" }],
  "2026-09-01",
  "2026-09-05",
);
check("五天五個桶", buckets.length, 5);
check(
  "每一天都有列（含 0 的那幾天）",
  buckets.map((b) => b.day),
  ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"],
);
check("9/3 是線上 700", [buckets[2].online, buckets[2].pos, buckets[2].total], [700, 0, 700]);
check("9/5 是門市 100", [buckets[4].online, buckets[4].pos, buckets[4].total], [0, 100, 100]);
check("9/2 是 0 而不是缺席", buckets[1].total, 0);
// 區間外的資料不可以溢出到邊界那一天。
const outside = R.bucketByDay(
  [paid({ total: 999, paid_at: "2026-10-20T02:00:00Z" })],
  [],
  "2026-09-01",
  "2026-09-05",
);
check(
  "區間外的訂單不會被塞進任何一個桶",
  outside.reduce((n, b) => n + b.total, 0),
  0,
);

// -----------------------------------------------------------------------------
console.log("\n[8] 空輸入");
// -----------------------------------------------------------------------------
check("沒有資料時全是 0", R.summariseRange([], [], "2026-09-01", "2026-09-30"), R.emptySummary());

// -----------------------------------------------------------------------------
// 收尾
// -----------------------------------------------------------------------------
console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
