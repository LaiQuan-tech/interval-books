#!/usr/bin/env node
/**
 * 跑完 scripts/*-selftest.mjs，並且**證明每一個都真的跑到了**。
 *
 * ── 為什麼需要「證明」這一步 ──────────────────────────────────────────────
 * 同團隊的 realreal 有過 4 支測試檔因為 vitest 的 `include` glob 沒對到而被靜默跳過，
 * CI 一路綠燈。關鍵在於**測試框架對「沒對到任何檔案的 glob」不會報錯** —— 綠燈的意思
 * 從「測試都過了」悄悄變成「沒有測試跑過」，而這兩件事在 CI 畫面上長得一模一樣。
 *
 * 所以這支 runner 不只是「跑測試」，它做四件互相獨立的比對：
 *
 *   1. **檔數對帳** —— 用 readdir 列出磁碟上所有 `*-selftest.mjs`，與實際執行的檔數
 *      相比。少一個就紅。
 *   2. **孤兒偵測** —— 掃出所有「名字裡有 test 卻不符合命名慣例」的 .mjs。它們永遠
 *      不會被跑到，而且沒有任何機制會告訴你。要嘛改名，要嘛寫進下面的 ALLOWLIST
 *      並附上理由 —— 重點是那個決定必須被寫下來，而不是靠沒人注意。
 *   3. **case 數對帳** —— 每支測試收尾要印一行 `##SELFTEST## file=… pass=N fail=N`，
 *      而且 `file=` 必須等於實際執行的路徑（防貼錯／複製別人的收尾行）。跑得起來
 *      但一個 case 都沒有的檔案也算失敗 —— 那是「測試被刪光只剩空殼」的樣子。
 *   4. **靜默回空字串的 read** —— 見下面「守門 4」的長註解。這是同一個「綠燈的意思
 *      悄悄改變了」的家族裡，最難用肉眼看出來的一支。
 *
 * 執行：node scripts/run-selftests.mjs  （或 npm test）
 */
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { parse as parseJs } from "@babel/parser";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS_DIR, "..");

/**
 * 名字裡有 test 但**刻意**不進這個 runner 的檔案。
 *
 * 每一筆都要有理由。清單本身會被印進 CI log，所以「偷偷加一筆讓 CI 變綠」這件事
 * 至少會留在紀錄上被看見。
 */
const ALLOWLIST = new Map([
  ["run-selftests.mjs", "這支 runner 自己"],
  ["amego-live-test.mjs", "會真的對 Amego 開發票，需 AMEGO_LIVE=1 手動執行，不進 CI"],
]);

const SUITE_PATTERN = /-selftest\.mjs$/;
const SUMMARY_RE = /^##SELFTEST## file=(\S+) pass=(\d+) fail=(\d+)$/m;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const files = readdirSync(SCRIPTS_DIR).sort();
const discovered = files.filter((f) => SUITE_PATTERN.test(f));

// ── 守門 1：孤兒測試檔 ────────────────────────────────────────────────────
const orphans = files.filter(
  (f) => f.endsWith(".mjs") && /test/i.test(f) && !SUITE_PATTERN.test(f) && !ALLOWLIST.has(f),
);

console.log("── 測試檔盤點 ──────────────────────────────────────");
console.log(`scripts/ 內共 ${files.length} 個檔案`);
console.log(`符合 *-selftest.mjs 的測試檔：${discovered.length}`);
for (const f of discovered) console.log(`  • scripts/${f}`);
if (ALLOWLIST.size > 0) {
  console.log(`刻意排除（ALLOWLIST）：${ALLOWLIST.size}`);
  for (const [f, why] of ALLOWLIST) console.log(`  • scripts/${f} — ${why}`);
}

let hardFail = false;

if (orphans.length > 0) {
  hardFail = true;
  console.log(
    red(
      `\n✗ 有 ${orphans.length} 個檔案看起來是測試，但不符合 *-selftest.mjs，` + `永遠不會被執行：`,
    ),
  );
  for (const f of orphans) console.log(red(`    scripts/${f}`));
  console.log(red("  → 改成 <名字>-selftest.mjs，或加進本檔的 ALLOWLIST 並寫清楚理由。"));
}

if (discovered.length === 0) {
  hardFail = true;
  console.log(red("\n✗ 一個測試檔都沒找到 —— 這代表 glob 壞了，不是「測試都過了」。"));
}

// ── 守門 4：讀不到檔案就回空字串的 read ───────────────────────────────────
//
// 這些自檢有大量斷言長成「讀某個檔的原始碼，確認裡面**沒有** X」：
//
//     check("…沒有 X", src.includes("X"), false);
//
// 只要 read 的形狀是 `existsSync(p) ? readFileSync(p, "utf8") : ""`，路徑一打錯
// （或那個檔被改名／搬走），`src` 就是 `""`，`"".includes("X")` 就是 `false`，
// 這條斷言**靜默通過**。它從此永遠是綠的，而且再也沒有在檢查任何東西。
//
// 這一類壞法的惡毒之處在於它只影響否定斷言：正面斷言（`checkTrue(…, src.includes("X"))`）
// 會立刻轉紅，所以是安全的；有人改路徑時看到全綠，會以為自己沒改壞。
//
// 所以 read 讀不到檔案時必須**丟例外**，訊息裡要有那個路徑。這個守門用 AST
// （不是 grep —— 註解裡的範例、字串裡的片段都不該算數）掃出任何一個「readFileSync
// 配一個空字串 fallback」的形狀，包括三元式、`|| ""`、以及 try/catch 吞掉。
const READ_FALLBACK_ALLOWLIST = new Map([
  // 目前沒有例外。真的需要「檔案可有可無」的讀取時，寫成 if (existsSync(p)) {…}
  // 明確分支，不要用會回空字串的表達式 —— 空字串會流進斷言，明確分支不會。
]);

/** 這個節點底下有沒有呼叫 readFileSync？ */
function callsReadFileSync(node) {
  let found = false;
  walk(node, (n) => {
    if (n.type !== "CallExpression") return;
    const c = n.callee;
    if (c?.type === "Identifier" && c.name === "readFileSync") found = true;
    if (c?.type === "MemberExpression" && c.property?.name === "readFileSync") found = true;
  });
  return found;
}

/** 這個節點底下有沒有出現空字串字面量？ */
function hasEmptyString(node) {
  let found = false;
  walk(node, (n) => {
    if (n.type === "StringLiteral" && n.value === "") found = true;
    if (n.type === "TemplateLiteral" && n.quasis?.length === 1 && n.quasis[0].value.cooked === "")
      found = true;
  });
  return found;
}

const isEmptyStr = (n) =>
  (n?.type === "StringLiteral" && n.value === "") ||
  (n?.type === "TemplateLiteral" && n.quasis?.length === 1 && n.quasis[0].value.cooked === "");

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    walk(node[key], visit);
  }
}

console.log("\n── 守門 4：read 讀不到檔案時會靜默回空字串嗎 ──────");
const silentReads = [];
for (const f of discovered) {
  let ast;
  try {
    ast = parseJs(readFileSync(join(SCRIPTS_DIR, f), "utf8"), {
      sourceType: "module",
      plugins: ["topLevelAwait"],
    });
  } catch (err) {
    hardFail = true;
    console.log(red(`✗ scripts/${f} 解析失敗，無法檢查：${err.message}`));
    continue;
  }
  walk(ast.program, (n) => {
    const line = n.loc?.start?.line ?? 0;
    let why = null;
    // a) existsSync(…) ? readFileSync(…) : ""   ／  反過來寫也算
    if (n.type === "ConditionalExpression") {
      if (isEmptyStr(n.alternate) && callsReadFileSync(n.consequent))
        why = "三元式的 else 分支是空字串";
      else if (isEmptyStr(n.consequent) && callsReadFileSync(n.alternate))
        why = "三元式的 then 分支是空字串";
    }
    // b) readFileSync(…) || ""  ／  ?? ""
    if (n.type === "LogicalExpression" && (n.operator === "||" || n.operator === "??")) {
      if (isEmptyStr(n.right) && callsReadFileSync(n.left))
        why = `readFileSync(…) ${n.operator} ""`;
    }
    // c) try { readFileSync(…) } catch { return "" }
    if (n.type === "TryStatement" && n.handler) {
      if (callsReadFileSync(n.block) && hasEmptyString(n.handler))
        why = "catch 分支把讀檔失敗換成空字串";
    }
    if (why) silentReads.push({ file: f, line, why });
  });
}

const flagged = silentReads.filter((s) => !READ_FALLBACK_ALLOWLIST.has(`${s.file}:${s.line}`));
if (flagged.length > 0) {
  hardFail = true;
  console.log(red(`✗ 有 ${flagged.length} 處「讀不到檔案就回空字串」的 read：`));
  for (const s of flagged) console.log(red(`    scripts/${s.file}:${s.line} —— ${s.why}`));
  console.log(
    red(
      '  → 這會讓 `check("…沒有 X", src.includes("X"), false)` 在路徑打錯時靜默通過。\n' +
        "    改成讀不到就 throw（訊息帶上路徑），或用明確的 if (existsSync(p)) 分支。",
    ),
  );
} else {
  console.log(green(`✓ ${discovered.length} 支自檢，沒有任何一處 read 會靜默回空字串`));
}

// ── 執行 ─────────────────────────────────────────────────────────────────
console.log("\n── 執行 ────────────────────────────────────────────");
const results = [];

for (const file of discovered) {
  const abs = join(SCRIPTS_DIR, file);
  const rel = relative(ROOT, abs);
  console.log(`\n▶ ${rel}`);
  const run = spawnSync(process.execPath, [abs], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });

  const stdout = run.stdout ?? "";
  process.stdout.write(stdout);
  if (run.stderr) process.stderr.write(run.stderr);

  const match = SUMMARY_RE.exec(stdout);
  results.push({
    file: rel,
    exitCode: run.status,
    reported: match ? { file: match[1], pass: Number(match[2]), fail: Number(match[3]) } : null,
  });
}

// ── 守門 2 & 3：檔數與 case 數對帳 ────────────────────────────────────────
console.log("\n── 對帳 ────────────────────────────────────────────");
console.log(`磁碟上的測試檔：${discovered.length}`);
console.log(`實際執行的檔數：${results.length}`);

if (discovered.length !== results.length) {
  hardFail = true;
  console.log(red("✗ 檔數對不上 —— 有測試檔沒有被執行。"));
}

let totalPass = 0;
let totalFail = 0;

for (const r of results) {
  if (r.reported === null) {
    hardFail = true;
    console.log(
      red(
        `✗ ${r.file} 沒有印出 ##SELFTEST## 收尾行（exit=${r.exitCode}）—— ` +
          `無法證明它真的跑了任何 case。`,
      ),
    );
    continue;
  }
  if (r.reported.file !== r.file) {
    hardFail = true;
    console.log(red(`✗ ${r.file} 的收尾行寫著 file=${r.reported.file} —— 收尾行貼錯檔案了。`));
    continue;
  }
  const cases = r.reported.pass + r.reported.fail;
  if (cases === 0) {
    hardFail = true;
    console.log(red(`✗ ${r.file} 跑起來了但一個 case 都沒有 —— 空殼測試。`));
    continue;
  }
  if (r.exitCode !== 0 || r.reported.fail > 0) {
    hardFail = true;
    console.log(
      red(
        `✗ ${r.file}：${r.reported.pass} passed, ${r.reported.fail} failed（exit=${r.exitCode}）`,
      ),
    );
  } else {
    console.log(green(`✓ ${r.file}：${cases} cases, 全部通過`));
  }
  totalPass += r.reported.pass;
  totalFail += r.reported.fail;
}

console.log("\n────────────────────────────────────────────────────");
console.log(
  `檔案 ${results.length} 個，case ${totalPass + totalFail} 個：${totalPass} passed, ${totalFail} failed`,
);
if (!process.env.AMEGO_LIVE) {
  console.log(
    yellow("備註：Amego 端到端（真的開一張發票再作廢）不在這裡，見 scripts/amego-live-test.mjs"),
  );
}

if (hardFail) {
  console.log(red("\n✗ 測試未通過\n"));
  process.exit(1);
}
console.log(green("\n✓ 全部通過\n"));
