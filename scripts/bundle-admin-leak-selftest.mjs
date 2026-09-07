#!/usr/bin/env node
/**
 * bundle-admin-leak-selftest.mjs —— 釘住「後台專用程式碼不得出現在訪客必載的 bundle 裡」
 *
 * ── 在查什麼 ──────────────────────────────────────────────────────────────
 * src/lib/admin/schemas.ts 是一份 1894 行、純後台用的 Zod 驗證規則 + 繁體中文
 * 錯誤訊息（進銷存、廠商 PII、後台帳號…）。它裡面的 `export const x = z.object(…)`
 * 全都沒有 `/* @__PURE__ *\/` 標記，Rollup 因此無法安全 tree-shake ——只要有任何一處
 * 「訪客一定會載到的程式碼」對它做真值引用（不是 import type），這份 1894 行就會
 * 整包被塞進訪客必載的 JS chunk。已經抓到過的真實案例：某支後台路由的 `loader`
 * 用一般 `import` 而不是動態 `await import()` 去載 src/lib/admin/fns/*.ts（那些
 * server function 檔案自己也對 schemas.ts 做真值引用），導致 __root__ 的 preload
 * chunk 裡混進了「請從清單選一個進銷存品項」這種只有後台才看得到的字串——每一位
 * 訪客造訪首頁、/shop、/events 都會下載到。
 *
 * ── 怎麼查 ────────────────────────────────────────────────────────────────
 * 1. 真的跑一次 `npm run build`（不讀舊產物、不相信上一次殘留的 .vercel/output——
 *    那樣的話改壞了程式碼但忘記重 build，這支自檢會對著舊的乾淨 bundle 傻笑）。
 * 2. 讀 TanStack Start 產生的 route manifest（.vercel/output/functions/__server.func/
 *    _tanstack-start-manifest_v-*.mjs），取出 __root__／「/」／「/shop/」／「/events/」
 *    這四個訪客路由的 preloads 聯集（外加 clientEntry）——這就是任何一位訪客造訪
 *    任何一頁時，瀏覽器實際會下載的 chunk 全集。
 * 3. 對這個集合裡的每一個 chunk 檔案，確認 4 個已知的後台專屬字串都不在裡面。
 *
 * ── 為什麼要真的重新 build，而不是讀既有產物 ─────────────────────────────────
 * 這支自檢的意義就是「code 改壞了要能抓到」。如果只讀既有的 .vercel/output，
 * 開發者很可能改壞程式碼後忘記重 build，看到這支測試綠燈就以為沒事——那是「綠燈
 * 的意思悄悄從『測試都過了』變成『沒有測試真的跑到新程式碼』」，正是
 * run-selftests.mjs 開頭那段話在講的同一個陷阱。所以寧可每次多花約 10-15 秒重
 * build，也不要相信任何殘留產物。
 *
 * ⚠️ 這支自檢的核心斷言（4 個字串）已經做過突變測試：把其中一個已修復的路由檔
 *    改回真值 import（例如 `_shell.strings.tsx` 改回
 *    `import { listUiStrings, updateUiStrings } from "@/lib/admin/fns/ui-strings"`）、
 *    重新跑這支自檢，斷言確實轉紅、訊息正確指出是哪個字串、出現在哪個 chunk；
 *    改回原本的動態 import 之後，重新跑一次確認轉綠。過程記錄在這次修復的
 *    session 報告裡，不是空話。
 *
 * ⚠️ 這支自檢也刻意守住「manifest 格式本身有沒有悄悄變了樣，讓我們其實什麼都沒在
 *    查」這件事——四個訪客路由 id 是否都還存在於 manifest、算出來的 chunk 集合
 *    是否還有一定規模，都各自是獨立的 case，而不是包在一個 try/catch 裡吞掉。
 *    任何一步讀不到檔案，一律丟例外並帶上路徑，不回空字串（見 run-selftests.mjs
 *    的「守門 4」——回空字串會讓 `check("…沒有 X", src.includes(X), false)` 這種
 *    否定斷言在路徑打錯時靜默通過）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/bundle-admin-leak-selftest.mjs";

const SERVER_FUNC_DIR = join(ROOT, ".vercel/output/functions/__server.func");
const STATIC_DIR = join(ROOT, ".vercel/output/static");

// 訪客一定會走到的路由 id（TanStack Start manifest 裡的 key，不是 URL 路徑——
// index 路由在 manifest 裡帶著結尾斜線，這是實測 build 產物確認過的形狀）。
const GUEST_ROUTE_IDS = ["__root__", "/", "/shop/", "/events/"];

// 已經逐行對回 src/lib/admin/schemas.ts 的 4 個後台專屬字串（進銷存 × 2、廠商 PII × 2）。
const TARGET_STRINGS = [
  "請從清單選一個進銷存品項",
  "沒有要盤點的商品",
  "廠商來電查詢",
  "請選擇廠商",
];

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

/** 讀檔。檔案不存在＝丟例外（帶路徑），不是回空字串——理由見檔頭。 */
function readFile(p) {
  if (!existsSync(p)) {
    throw new Error(
      `selftest 讀不到檔案：${p}（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串。）`,
    );
  }
  return readFileSync(p, "utf8");
}

// -----------------------------------------------------------------------------
// [1] 真的重新 build 一次
// -----------------------------------------------------------------------------
console.log("── [1] npm run build ──────────────────────────────");
const buildStart = Date.now();
const build = spawnSync("npm", ["run", "build"], {
  cwd: ROOT,
  encoding: "utf8",
});
const buildSeconds = ((Date.now() - buildStart) / 1000).toFixed(1);

if (build.status !== 0) {
  console.log(red(`\n✗ npm run build 失敗（exit=${build.status}，耗時 ${buildSeconds}s）：\n`));
  console.log(build.stdout ?? "");
  console.log(build.stderr ?? "");
  console.log(`\n##SELFTEST## file=${SELF} pass=0 fail=1`);
  console.log(red("✗ 有失敗：0 passed, 1 failed\n"));
  process.exit(1);
}
checkTrue(`build 成功（耗時 ${buildSeconds}s）`, true);

// -----------------------------------------------------------------------------
// [2] 讀 route manifest，取出訪客可觸及的 chunk 集合
// -----------------------------------------------------------------------------
console.log("\n── [2] 解析 route manifest ─────────────────────────");

if (!existsSync(SERVER_FUNC_DIR)) {
  throw new Error(
    `selftest 讀不到 server function 輸出目錄：${SERVER_FUNC_DIR}` +
      "（build 產物路徑可能變了——這支自檢假設的是 vercel nitro preset 的輸出形狀。）",
  );
}
const manifestFile = readdirSync(SERVER_FUNC_DIR).find((f) =>
  f.startsWith("_tanstack-start-manifest"),
);
checkTrue(
  "找得到 _tanstack-start-manifest_*.mjs",
  manifestFile !== undefined,
  `掃描目錄：${SERVER_FUNC_DIR}`,
);
if (!manifestFile) {
  console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
  console.log(red("✗ 有失敗：manifest 都找不到，後面的檢查沒有意義，提前結束。\n"));
  process.exit(1);
}

const manifestPath = join(SERVER_FUNC_DIR, manifestFile);
const manifestModule = await import(pathToFileURL(manifestPath).href);
checkTrue(
  "manifest 模組有 export tsrStartManifest",
  typeof manifestModule.tsrStartManifest === "function",
);
const manifest = manifestModule.tsrStartManifest();

const chunkSet = new Set();
if (manifest.clientEntry) chunkSet.add(manifest.clientEntry);

for (const routeId of GUEST_ROUTE_IDS) {
  const route = manifest.routes?.[routeId];
  checkTrue(
    `manifest.routes 裡找得到訪客路由 "${routeId}"`,
    route !== undefined,
    "manifest 的路由 id 命名格式可能變了（例如 index 路由的結尾斜線）——" +
      "去重新讀一次 build 產物確認實際的 key 長什麼樣子，不要直接改期望值糊過去。",
  );
  if (!route) continue;
  for (const p of route.preloads ?? []) chunkSet.add(p);
}

checkTrue(
  `訪客可觸及的 chunk 集合有一定規模（實際 ${chunkSet.size} 個，需要 ≥ 5）`,
  chunkSet.size >= 5,
  "數量異常小，可能代表上面的路由 id 沒對到、或 manifest 形狀變了，導致這支測試" +
    "其實幾乎沒在檢查任何東西。",
);

// -----------------------------------------------------------------------------
// [3] 逐一檢查訪客可觸及的每個 chunk，確認 4 個後台專屬字串都不在裡面
// -----------------------------------------------------------------------------
console.log("\n── [3] 掃描每個訪客 chunk ──────────────────────────");

const chunkPaths = [...chunkSet].sort();
console.log(`  共 ${chunkPaths.length} 個 chunk：${chunkPaths.join(", ")}`);

/** string -> [{chunk, bytes}] 的命中紀錄，用來在失敗訊息裡指出確切位置。 */
const hits = new Map(TARGET_STRINGS.map((s) => [s, []]));

for (const chunkPath of chunkPaths) {
  const abs = join(STATIC_DIR, chunkPath);
  if (!existsSync(abs)) {
    throw new Error(
      `selftest 讀不到 chunk 檔案：${abs}` +
        `（manifest 裡列了 "${chunkPath}"，但 .vercel/output/static 底下沒有這個檔——` +
        "build 產物不一致，不是「沒有洩漏」。）",
    );
  }
  const src = readFile(abs);
  for (const s of TARGET_STRINGS) {
    if (src.includes(s)) hits.get(s).push(chunkPath);
  }
}

for (const s of TARGET_STRINGS) {
  const hitChunks = hits.get(s);
  checkTrue(
    `訪客可觸及的 chunk 都不含後台專屬字串「${s}」`,
    hitChunks.length === 0,
    hitChunks.length > 0
      ? `出現在：${hitChunks.map((c) => `${c}（${statSync(join(STATIC_DIR, c)).size} bytes）`).join("、")}`
      : undefined,
  );
}

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
