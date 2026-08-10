#!/usr/bin/env node
/**
 * 檢查 CI 設定本身沒有被開後門。
 *
 * ── 為什麼要有這一支 ──────────────────────────────────────────────────────
 * 測試會不會跑，最後取決於一個 YAML 檔，而那個檔案有兩個「讓紅燈變綠」的旋鈕：
 *
 *   continue-on-error: true   —— step 失敗但 job 照樣成功
 *   if: <條件>                —— 條件寫錯時整個 step 被跳過，而**跳過的 step 在 CI
 *                                畫面上長得跟通過一樣**（灰色勾勾，不是紅叉）
 *
 * 兩個都是修 CI 時最順手的解法，也都會在 review 裡以「只是設定檔的小改動」被放過去。
 * 之後沒有人會發現測試其實沒在跑 —— 這正是 realreal 那 4 支被靜默跳過的測試檔
 * 留下的教訓的另一半：光有 runner 的檔數對帳不夠，runner 本身也要真的被執行。
 *
 * 所以這支腳本**用真正的 YAML parser 解析**（不是 grep：`# continue-on-error` 這種
 * 註解不該算數，而多層縮排下的 key 用正則抓也不可靠），逐個 step 檢查。
 *
 * 執行：node scripts/check-ci.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(ROOT, ".github/workflows/tests.yml");

/** 這些 job 一定要存在，而且一定要是無條件、不可失敗的。 */
const REQUIRED_JOBS = ["selftests", "ci-integrity"];

/** selftests 一定要真的跑到這些指令，否則「job 存在」只是個空殼。 */
const REQUIRED_COMMANDS = ["npm ci", "npm test"];

const problems = [];
const notes = [];

let doc;
try {
  doc = parse(readFileSync(WORKFLOW, "utf8"));
} catch (err) {
  console.error(`✗ 無法解析 ${WORKFLOW}`);
  console.error(err);
  process.exit(1);
}

const jobs = doc?.jobs ?? {};

for (const jobName of REQUIRED_JOBS) {
  const job = jobs[jobName];
  if (!job) {
    problems.push(`job "${jobName}" 不見了 —— 測試沒有東西會跑它`);
    continue;
  }

  if ("continue-on-error" in job) {
    problems.push(`job "${jobName}" 有 continue-on-error（job 級）—— 失敗也會變成成功`);
  }
  if ("if" in job) {
    problems.push(
      `job "${jobName}" 有 if: ${JSON.stringify(job.if)} —— 條件不成立時整個 job 被跳過`,
    );
  }

  const steps = Array.isArray(job.steps) ? job.steps : [];
  if (steps.length === 0) {
    problems.push(`job "${jobName}" 沒有任何 step`);
  }

  steps.forEach((step, i) => {
    const label = `${jobName}.steps[${i}]${step?.name ? ` (${step.name})` : ""}`;
    if (step && "continue-on-error" in step) {
      problems.push(`${label} 有 continue-on-error —— 失敗也會變成成功`);
    }
    if (step && "if" in step) {
      problems.push(
        `${label} 有 if: ${JSON.stringify(step.if)} —— 條件不成立時這個 step 被靜默跳過`,
      );
    }
  });

  notes.push(`job "${jobName}"：${steps.length} steps，無 continue-on-error、無 if`);
}

// selftests 真的有在跑測試嗎
const selftestRuns = (jobs.selftests?.steps ?? []).map((s) => String(s?.run ?? "")).join("\n");
for (const cmd of REQUIRED_COMMANDS) {
  if (!selftestRuns.includes(cmd)) {
    problems.push(`selftests job 裡找不到 \`${cmd}\` —— 這個 job 沒有在跑測試`);
  } else {
    notes.push(`selftests job 有跑 \`${cmd}\``);
  }
}

// 觸發條件：push main 與 PR 都要涵蓋，否則「合併前 CI 綠燈」保證不了什麼
const on = doc?.on ?? doc?.true; // YAML 1.1 會把裸 `on` 讀成 boolean true
const branchesOf = (v) => (Array.isArray(v?.branches) ? v.branches : []);
if (!branchesOf(on?.push).includes("main")) {
  problems.push("workflow 沒有在 push main 時觸發");
} else {
  notes.push("push main 會觸發");
}
if (!branchesOf(on?.pull_request).includes("main")) {
  problems.push("workflow 沒有在 PR to main 時觸發");
} else {
  notes.push("PR to main 會觸發");
}

console.log("── CI 設定檢查（YAML parse，不是 grep）──────────────");
console.log(`檔案：.github/workflows/tests.yml`);
for (const n of notes) console.log(`  \x1b[32m✓\x1b[0m ${n}`);

if (problems.length > 0) {
  console.log("");
  for (const p of problems) console.log(`  \x1b[31m✗\x1b[0m ${p}`);
  console.log(`\n\x1b[31m✗ CI 設定有 ${problems.length} 個問題\x1b[0m\n`);
  process.exit(1);
}

console.log("\n\x1b[32m✓ CI 設定沒有逃生門\x1b[0m\n");
