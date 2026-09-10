#!/usr/bin/env node
/**
 * ops/amego-relay/server.js 的自我測試。
 *
 * ── 為什麼這支測試存在 ───────────────────────────────────────────────────
 * 2026-09-07 中繼上線之後，開發票全部失敗，症狀是 `amego code=transport msg=`
 * ——一句沒有內容的錯誤訊息，而且被判成永久失敗、不再重試。查了三天，真正的原因是
 * 中繼的白名單把 `/json/f0401` 打成 `/json/c0401`：**作廢、查詢都正常，只有開立
 * 被 404 擋掉**。單看中繼「有回應、健康檢查是綠的」，單看 app「有送出去」，兩邊
 * 各自都不像壞了。
 *
 * 所以這支測試的重點不是「中繼跑得起來」，是兩件事：
 *   [1] 中繼的白名單與 src/server/amego.ts 實際會打的路徑**逐字對得起來**（靜態）
 *   [2] 中繼真的照白名單放行／擋下，而且 body 逐位元組轉送（起真的 server 打真的請求）
 *
 * 執行：node scripts/amego-relay-selftest.mjs
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_SRC = join(ROOT, "ops/amego-relay/server.js");
const AMEGO_SRC = join(ROOT, "src/server/amego.ts");

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    console.log(`      預期 ${JSON.stringify(expected)}，實際 ${JSON.stringify(actual)}`);
  }
}

// ── 抽取器 ────────────────────────────────────────────────────────────────
// 兩邊都從**原始碼**抽，不從註解抽——註解說什麼不影響跑起來的行為。

/** 中繼白名單裡的路徑。 */
function relayAllowed(source, setName) {
  const m = source.match(new RegExp(`const ${setName} = new Set\\(\\[([^\\]]*)\\]`));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

/** src/server/amego.ts 裡 amegoRequest() 實際打的路徑。 */
function appPostPaths(source) {
  return [...source.matchAll(/amegoRequest\(\s*"([^"]+)"/g)].map((m) => m[1]).sort();
}

/** src/server/amego.ts 裡用 GET 打的路徑（校時）。 */
function appGetPaths(source) {
  return [...source.matchAll(/\$\{base\}(\/json\/\w+)`/g)].map((m) => m[1]).sort();
}

const relaySrc = readFileSync(RELAY_SRC, "utf8");
const amegoSrc = readFileSync(AMEGO_SRC, "utf8");

console.log("\n[1] 白名單與 app 實際打的路徑逐字對帳");
{
  const post = relayAllowed(relaySrc, "ALLOWED_POST_PATHS");
  const get = relayAllowed(relaySrc, "ALLOWED_GET_PATHS");
  check("抽得到 ALLOWED_POST_PATHS（抽不到代表這支測試瞎了）", Array.isArray(post), true);
  check("抽得到 ALLOWED_GET_PATHS", Array.isArray(get), true);

  const wantPost = appPostPaths(amegoSrc);
  const wantGet = appGetPaths(amegoSrc);
  check("app 的 POST 路徑抽得到（至少 3 條）", wantPost.length >= 3, true);
  check("app 的 GET 路徑抽得到（至少 1 條）", wantGet.length >= 1, true);

  // 🔴 這一條就是當年沒有的那一條。
  const missingPost = wantPost.filter((p) => !post.includes(p));
  check(
    `🔴 每一條 app 會 POST 的路徑都在中繼白名單裡（缺 ${missingPost.join(",") || "無"}）`,
    missingPost,
    [],
  );
  const missingGet = wantGet.filter((p) => !get.includes(p));
  check(
    `🔴 每一條 app 會 GET 的路徑都在中繼白名單裡（缺 ${missingGet.join(",") || "無"}）`,
    missingGet,
    [],
  );

  // 反面對照：把中繼原始碼的 f0401 改成 c0401（就是當年那個錯字），偵測器必須抓到。
  // 沒有這一段的話，「missing 是空陣列」也可能是因為抽取器根本沒抽到東西。
  const mutated = relaySrc.replace('"/json/f0401"', '"/json/c0401"');
  check("突變測試：原始碼真的被改到了", mutated !== relaySrc, true);
  const mutatedPost = relayAllowed(mutated, "ALLOWED_POST_PATHS");
  const caught = wantPost.filter((p) => !mutatedPost.includes(p));
  check("🔴 突變測試：f0401→c0401 必須被抓到", caught, ["/json/f0401"]);
}

// ── 行為測試：起真的 server ───────────────────────────────────────────────
console.log("\n[2] 中繼實際行為（起真的 HTTP server）");

const SECRET = "selftest-secret-not-a-real-one";
const received = [];

/** 假的 Amego：把收到的東西記下來，回一個看得出是自己的 JSON。 */
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received.push({
      method: req.method,
      url: req.url,
      contentType: req.headers["content-type"] || null,
      // 🔴 中繼宣稱 body 逐位元組不動（sign 依賴這件事）。存原始 bytes 才驗得到。
      body: Buffer.concat(chunks).toString("binary"),
      // 中繼密鑰絕不可以被轉送到上游。
      relaySecretHeader: req.headers["x-relay-secret"] ?? null,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, msg: "fake-upstream-ok" }));
  });
});

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
}

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* 還沒起來 */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const upstreamPort = await listen(upstream);
const relayPort = 4000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, [RELAY_SRC], {
  env: {
    ...process.env,
    PORT: String(relayPort),
    RELAY_SECRET: SECRET,
    AMEGO_BASE: `http://127.0.0.1:${upstreamPort}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayStderr = "";
child.stderr.on("data", (d) => (relayStderr += d.toString()));
const relayStdout = [];
child.stdout.on("data", (d) => relayStdout.push(d.toString()));

const base = `http://127.0.0.1:${relayPort}`;
const up = await waitFor(`${base}/healthz`);
check("中繼起得來，/healthz 回 200（不需密鑰）", up, true);

if (up) {
  const post = (path, headers = {}, body = "a=1&b=%E4%B8%AD") =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body,
    });

  // (a) 沒帶密鑰 → 401，而且**不可以**已經先轉送出去
  {
    const before = received.length;
    const r = await post("/json/f0401");
    check("🔴 沒帶密鑰 → 401", r.status, 401);
    check("🔴 沒帶密鑰時上游一個請求都沒收到", received.length, before);
  }

  // (b) 密鑰錯 → 401
  {
    const r = await post("/json/f0401", { "x-relay-secret": "wrong" });
    check("🔴 密鑰錯 → 401", r.status, 401);
  }

  // (c) 密鑰對 + f0401 → 轉送，且 body 逐位元組相同、密鑰不外流
  {
    const body = "invoice=53912857&data=%5B%7B%22a%22%3A1%7D%5D&time=123&sign=abc";
    const r = await post("/json/f0401", { "x-relay-secret": SECRET }, body);
    check("🔴 f0401（開立發票）放行 → 200", r.status, 200);
    check("回應內容原樣帶回", (await r.json()).msg, "fake-upstream-ok");
    const last = received.at(-1);
    check("上游收到的是 POST /json/f0401", `${last.method} ${last.url}`, "POST /json/f0401");
    check("🔴 body 逐位元組相同（sign 靠這件事）", last.body, body);
    check(
      "Content-Type 照抄，沒被改成 application/json",
      last.contentType,
      "application/x-www-form-urlencoded",
    );
    check("🔴 中繼密鑰沒有被轉送到上游", last.relaySecretHeader, null);
  }

  // (d) 其餘白名單路徑
  for (const p of ["/json/f0501", "/json/invoice_query"]) {
    const r = await post(p, { "x-relay-secret": SECRET });
    check(`${p} 放行 → 200`, r.status, 200);
  }

  // (e) GET /json/time（校時）
  {
    const r = await fetch(`${base}/json/time`, { headers: { "x-relay-secret": SECRET } });
    check("🔴 GET /json/time（校時）放行 → 200", r.status, 200);
    check(
      "上游收到的是 GET /json/time",
      `${received.at(-1).method} ${received.at(-1).url}`,
      "GET /json/time",
    );
  }

  // (f) 不在白名單上的路徑 → 404，且沒有轉送
  {
    const before = received.length;
    const r = await post("/json/c0401", { "x-relay-secret": SECRET });
    check("白名單外的路徑 → 404", r.status, 404);
    check("404 的回應是 JSON 且說得出原因", (await r.json()).error, "path_not_allowed");
    check("被擋下的請求沒有轉送到上游", received.length, before);
  }

  // (g) GET 不可以借用 POST 的白名單（反過來也是）
  {
    const r = await fetch(`${base}/json/f0401`, { headers: { "x-relay-secret": SECRET } });
    check("🔴 GET 打 POST 的路徑 → 404（白名單不共用）", r.status, 404);
    const r2 = await post("/json/time", { "x-relay-secret": SECRET });
    check("🔴 POST 打 GET 的路徑 → 404", r2.status, 404);
  }
}

child.kill();
upstream.close();
check("中繼沒有把密鑰印進 stderr", relayStderr.includes(SECRET), false);
check("中繼沒有把密鑰印進 stdout", relayStdout.join("").includes(SECRET), false);

// ── 未設密鑰時整支關起來 ──────────────────────────────────────────────────
console.log("\n[3] 未設 RELAY_SECRET 時的姿態");
{
  const port2 = 5000 + Math.floor(Math.random() * 1000);
  const c2 = spawn(process.execPath, [RELAY_SRC], {
    env: {
      ...process.env,
      PORT: String(port2),
      RELAY_SECRET: "",
      AMEGO_BASE: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const ok = await waitFor(`http://127.0.0.1:${port2}/healthz`);
  check("沒設密鑰時中繼還是起得來（健康檢查要能過）", ok, true);
  if (ok) {
    const r = await fetch(`http://127.0.0.1:${port2}/json/f0401`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    // 🔴 預設放行 = 任何人都能借用光貿放行過的 IP 開發票。沒設密鑰一律 503。
    check("🔴 沒設密鑰 → 轉送一律 503，不是放行", r.status, 503);
  }
  c2.kill();
}

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=scripts/amego-relay-selftest.mjs pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m\n`);
  process.exit(0);
} else {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(1);
}
