/**
 * Amego 發票中繼（Railway）。
 *
 * 為什麼存在：Amego（光貿）用 IP 白名單控管，而 Vercel 的出口 IP 是浮動的，永遠
 * 不可能被白名單。這支中繼跑在 Railway 的固定出口 IP 上，光貿只需要放行那組 IP，
 * Vercel 就打得到 Amego。
 *
 * 它做的事只有一件：**原封不動轉送**。body 逐位元組不動（sign 是 Vercel 端用
 * AMEGO_APP_KEY 算好的，中繼不參與簽章、也拿不到 AppKey），只換掉目的地 host。
 *
 * 🔴 這個檔案必須留在 repo 裡。它曾經只存在於某次 session 的暫存目錄，暫存被清掉
 *    之後就只剩下「跑在 Railway 上的那份」，改都改不了——而當時它正好有個會擋掉
 *    開發票的錯字（見下方 ALLOWED_POST_PATHS）。
 */
const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.RELAY_SECRET || "";
const AMEGO_BASE = process.env.AMEGO_BASE || "https://invoice-api.amego.tw";

/**
 * 允許轉送的 POST 路徑。
 *
 * 🔴 這串字必須與 src/server/amego.ts 裡 amegoRequest() 實際打的路徑逐字相同。
 *    2026-09 這裡曾經把 f0401（開立發票）打成 c0401，結果：作廢與查詢都正常，
 *    **只有開發票**回 404，5 張發票卡了三天。scripts/amego-selftest.mjs 現在會
 *    交叉比對這兩份清單，改任何一邊而沒改另一邊都會紅。
 *
 *   /json/f0401        開立發票（自動配號）
 *   /json/f0501        作廢發票
 *   /json/invoice_query 查詢發票
 */
const ALLOWED_POST_PATHS = new Set(["/json/f0401", "/json/f0501", "/json/invoice_query"]);

/**
 * 允許轉送的 GET 路徑。
 *
 * /json/time 是校時用的，不需簽章也不需參數。收到 code 15（時間戳記錯誤）時
 * amegoRequest() 會打它一次再重送——沒有它，時鐘一漂移就是全部發票同時開不出來。
 */
const ALLOWED_GET_PATHS = new Set(["/json/time"]);

const UPSTREAM_TIMEOUT_MS = 20_000;

function send(res, status, payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      // 發票 body 只有幾 KB。設上限是為了不讓這支中繼變成任何人的記憶體炸彈。
      if (size > 1_000_000) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || "").split("?")[0];
  const method = req.method || "";

  // 健康檢查不需密鑰：Railway 自己要打它，而且它什麼都不轉送。
  if (method === "GET" && path === "/healthz") return send(res, 200, { ok: true });

  if (method !== "POST" && method !== "GET") {
    return send(res, 405, { error: "method_not_allowed" });
  }

  // 沒設密鑰就整支關起來。預設放行的中繼＝任何人都能用光貿放行過的 IP 開發票。
  if (!SECRET) return send(res, 503, { error: "relay_not_configured" });
  if (req.headers["x-relay-secret"] !== SECRET) return send(res, 401, { error: "unauthorized" });

  const allowed = method === "POST" ? ALLOWED_POST_PATHS : ALLOWED_GET_PATHS;
  if (!allowed.has(path)) return send(res, 404, { error: "path_not_allowed" });

  try {
    const init = {
      method,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    };
    if (method === "POST") {
      // Content-Type 照抄呼叫端的。Amego 只吃 x-www-form-urlencoded，送 application/json
      // 會回 code 11（解析不到欄位）——這裡自作聰明改寫的話，症狀會出現在 Vercel 那端。
      init.headers = {
        "Content-Type": req.headers["content-type"] || "application/x-www-form-urlencoded",
      };
      init.body = await readBody(req);
    }
    const upstream = await fetch(`${AMEGO_BASE}${path}`, init);
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(text);
  } catch (err) {
    // 上游的失敗要看得出來是上游。訊息裡不可以出現 SECRET。
    const msg = err && err.message ? String(err.message) : "unknown";
    console.error(`[relay] upstream failed path=${path} method=${method} err=${msg}`);
    send(res, 502, { error: "upstream_failed", detail: msg });
  }
});

server.listen(PORT, () => {
  console.log(`[relay] listening on ${PORT} → ${AMEGO_BASE}`);
  console.log(`[relay] POST ${[...ALLOWED_POST_PATHS].join(" ")}`);
  console.log(`[relay] GET  ${[...ALLOWED_GET_PATHS].join(" ")}`);
  if (!SECRET) console.error("[relay] ⚠️ RELAY_SECRET 未設定，所有轉送都會回 503");
});
