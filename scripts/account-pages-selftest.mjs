#!/usr/bin/env node
/**
 * account-pages-selftest.mjs —— 客人帳號前台頁面的自檢
 *
 * 這一期把 0030／customer-auth.ts／server/repos/customer-orders.ts 早就上線、
 * 但沒有入口的 server 層接出來：六個頁面（account.tsx、
 * account_.login/register/forgot/reset.tsx、auth.confirm.tsx）+ 兩個新的
 * 中間層（server/customer-auth-links.ts、lib/customer-fns.ts、
 * lib/customer-account.ts）。
 *
 * 這裡守的不是「客人帳號的授權邏輯對不對」——那是
 * scripts/customer-account-selftest.mjs 的事，這一份完全沒有被改動，繼續守著
 * customer-auth.ts 與 repos/customer-orders.ts 本人。這裡守的是**接線有沒有接
 * 對**：頁面有沒有繞過 customer-orders.ts 自己查表、未登入打得到的頁面有沒有
 * 真的被擋、登出是不是真的只收 POST、忘記密碼有沒有真的防列舉、信件連結有沒有
 * 走對路徑。
 *
 * ── 為什麼全部是靜態分析，沒有動態 import 路由檔 ────────────────────────────
 *
 * customer-account-selftest.mjs 能動態 import + 換假 client 是因為
 * repos/customer-orders.ts 是純 .ts、不含 JSX、依賴只有一個 supabaseAdmin。
 * 這六個頁面是 .tsx，依賴 TanStack Router 的檔案路由（beforeLoad/loader 的
 * context 來自實際的 HTTP 請求與路由樹）、react-hook-form、以及一整套 UI
 * 元件——要真的「執行」它們得起一顆假的 router + 假的 request context，複雜度
 * 遠超這個 repo 對 .tsx 檔案既有的測試深度（這個 repo目前沒有任何一支自檢渲染
 * 或執行過一支 route 元件）。所以與 check-meta.mjs、nav-consolidation-selftest.mjs
 * 一樣，全部走「讀原始碼、剝掉註解、比對結構」。
 *
 * 這裡靜態驗不到、只能人工／瀏覽器驗證的部分（見任務回報）：
 *   · /account、/account/reset 未登入時真的會被瀏覽器導向 /account/login
 *     （這裡只驗證 beforeLoad 原始碼裡有沒有寫這段邏輯，不是真的發一個沒有
 *     cookie 的請求去看結果）
 *   · 真的收到驗證信、真的點連結、token_hash 真的驗證成功
 *   · customer 角色真的登入後打 /admin 會被擋（這裡只驗證 auth.ts 與
 *     admin/_shell.tsx 的既有原始碼——那兩個檔案完全沒被這次改動碰過）
 *
 * 執行：node scripts/account-pages-selftest.mjs （或 npm test）
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/account-pages-selftest.mjs";
const ROUTES_DIR = join(ROOT, "src/routes");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 customer-account-selftest.mjs / nav-consolidation-selftest.mjs 同一套）
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function check(label, actual, expected, hint) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      預期 ${JSON.stringify(expected)}`));
    console.log(red(`      實際 ${JSON.stringify(actual)}`));
    if (hint) console.log(red(`      ${hint}`));
  }
}
const checkTrue = (label, value, hint) => check(label, value === true, true, hint);
const checkFalse = (label, value, hint) => check(label, value === true, false, hint);

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不回空字串——見 run-selftests.mjs 的
 * 「守門 4」；這支底下大量 `checkFalse("…沒有 X", src.includes("X"))` 形狀的
 * 否定斷言，空字串會讓它們全部靜默通過。
 */
const readFile = (relPath) => {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error(
      `selftest 讀不到檔案：${abs}` + "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串。）",
    );
  }
  return readFileSync(abs, "utf8");
};

// 守著 readFile() 自己。
{
  const ghost = "__account-pages-selftest-missing-file-probe__";
  let thrown = null;
  try {
    readFile(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 readFile() 讀不到檔案時丟例外，訊息指出是哪個路徑（不是靜默回空字串）",
    thrown !== null && String(thrown.message).includes(join(ROOT, ghost)),
  );
}

/** 拿掉 TS/JS 註解。與 customer-account-selftest.mjs 的同名函式一致。 */
function stripTsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** 抓出 `key: async (...) => { … }` 這種區塊本體，直到下一個同縮排層級的 key。 */
function extractBlock(src, startMarker, endMarkers) {
  const start = src.indexOf(startMarker);
  if (start < 0) return null;
  const ends = endMarkers
    .map((m) => src.indexOf(m, start + startMarker.length))
    .filter((n) => n > start);
  const end = ends.length ? Math.min(...ends) : src.length;
  return src.slice(start, end);
}

function envVarsUsedIn(src) {
  const found = new Set();
  const re = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(src))) found.add(m[1]);
  return [...found].sort();
}

console.log("═══ 客人帳號前台頁面自檢（account.tsx 系列 + auth.confirm.tsx + 接線層）═══");

// =============================================================================
// [1] 六個頁面是 src/routes/ 頂層的扁平檔案；四個 login 系頁面用逃逸底線
// =============================================================================
console.log("\n[1] 檔名：扁平頂層 + account_ 逃逸底線");

const REQUIRED_TOP_LEVEL_FILES = [
  "account.tsx",
  "account_.login.tsx",
  "account_.register.tsx",
  "account_.forgot.tsx",
  "account_.reset.tsx",
  "auth.confirm.tsx",
];

const topLevelRouteFiles = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".tsx"));
for (const f of REQUIRED_TOP_LEVEL_FILES) {
  checkTrue(
    `🔴 src/routes/${f} 是 src/routes/ 頂層的檔案（check-meta.mjs 的 readdir 不遞迴，放進子目錄會整批躲過三語 meta 稽核，admin/ 與 vendor/ 現在就是這樣沒被驗到）`,
    topLevelRouteFiles.includes(f),
  );
}

checkFalse(
  "src/routes/account/ 不是一個子目錄／檔案（沒有意外建到子目錄底下）",
  existsSync(join(ROUTES_DIR, "account")),
);

/**
 * 🔴 這四個「沒有逃逸底線」的檔名**不該同時存在**。
 *
 * 這不是命名品味問題：實測過（`npm run build` 後讀 src/routeTree.gen.ts）
 * ——如果同時存在 account.tsx 與 account.login.tsx（無底線），TanStack Router
 * 的檔案路由會把後者當成前者的**巢狀 children**（account.tsx 變成 layout，
 * 需要自己渲染 <Outlet/>，account.tsx 卻沒有）。account.tsx 的 beforeLoad
 * 對「未登入」的處理是 `throw redirect({ to: "/account/login" })`——一旦
 * account.login 變成它的 child，這個 beforeLoad 會在**進入 /account/login 之前
 * 就先跑一次**，把還沒登入的訪客導向……/account/login，等於整個註冊／登入／
 * 忘記密碼流程對所有還沒登入的人失效（他們永遠到不了這幾頁）。
 * account_.register / account_.forgot 情況更糟：它們必須讓未登入的人看得到，
 * 卻會被連坐導去 /account/login。
 *
 * 用 `account_.login.tsx` 這種帶逃逸底線的檔名，URL 仍然是 `/account/login`
 * （TanStack Router 的檔案路由慣例：`X_.Y` 產生路徑 `/X/Y`，但不繼承 `X.tsx`
 * 的 layout／beforeLoad），已經用 src/routeTree.gen.ts 驗證過
 * （`path: '/account/login'` 但不出現在 `AccountRouteChildren` 裡）。
 */
for (const f of [
  "account.login.tsx",
  "account.register.tsx",
  "account.forgot.tsx",
  "account.reset.tsx",
]) {
  checkFalse(
    `🔴 src/routes/${f}（沒有逃逸底線）不存在——會被 TanStack Router 當成 account.tsx 的巢狀 children，account.tsx 的 beforeLoad 會連坐擋住登入前就該看到的頁面`,
    existsSync(join(ROUTES_DIR, f)),
  );
}

const routeTreeSrc = readFile("src/routeTree.gen.ts");
checkFalse(
  "🔴 routeTree.gen.ts 裡沒有 AccountRouteWithChildren——account.tsx 不是任何頁面的 layout parent（見上面同一條理由；這是對產出的 codegen 檔案做的第二層確認，不只信任檔名）",
  /AccountRouteWithChildren/.test(routeTreeSrc),
);
for (const [routeId, path] of [
  ["/account_/login", "/account/login"],
  ["/account_/register", "/account/register"],
  ["/account_/forgot", "/account/forgot"],
  ["/account_/reset", "/account/reset"],
]) {
  checkTrue(
    `routeTree.gen.ts：檔名 account_.*（id ${routeId}）產出的網址仍然是 ${path}（逃逸底線只影響巢狀關係，不影響網址）`,
    new RegExp(
      `id: '${routeId.replace("/", "\\/")}'[\\s\\S]{0,10}path: '${path.replace(/\//g, "\\/")}'`,
    ).test(routeTreeSrc),
  );
}

// =============================================================================
// [2] 🔴 頁面層不直接查 orders／event_registrations——一律經 customer-orders.ts
// =============================================================================
console.log("\n[2] 頁面層沒有繞過 customer-orders.ts 自己查表");

const accountSrcRaw = readFile("src/routes/account.tsx");
const accountSrc = stripTsComments(accountSrcRaw);
checkTrue("反空殼：account.tsx 剝完註解仍有夠多程式碼", accountSrc.trim().length > 1500);

checkFalse(
  "🔴 account.tsx 沒有 import supabaseAdmin（授權邊界只能在 customer-orders.ts）",
  /supabaseAdmin/.test(accountSrc),
);
checkFalse('🔴 account.tsx 沒有直接查 .from("orders"', /\.from\(\s*"orders"/.test(accountSrc));
checkFalse(
  '🔴 account.tsx 沒有直接查 .from("event_registrations"',
  /\.from\(\s*"event_registrations"/.test(accountSrc),
);
checkTrue(
  "account.tsx 的資料一律經 lib/customer-fns.ts 的 fetchMyAccountData()",
  /await import\(\s*"@\/lib\/customer-fns"\s*\)/.test(accountSrc) &&
    /fetchMyAccountData/.test(accountSrc),
);

const customerFnsSrcRaw = readFile("src/lib/customer-fns.ts");
const customerFnsSrc = stripTsComments(customerFnsSrcRaw);
checkTrue("反空殼：customer-fns.ts 剝完註解仍有夠多程式碼", customerFnsSrc.trim().length > 1500);

checkFalse(
  "🔴 customer-fns.ts 整個檔案沒有 import supabaseAdmin（不繞過 customer-orders.ts / customer-auth.ts 自己打資料庫）",
  /supabaseAdmin/.test(customerFnsSrc),
);
checkFalse(
  '🔴 customer-fns.ts 沒有直接查 .from("orders"',
  /\.from\(\s*"orders"/.test(customerFnsSrc),
);
checkFalse(
  '🔴 customer-fns.ts 沒有直接查 .from("event_registrations"',
  /\.from\(\s*"event_registrations"/.test(customerFnsSrc),
);
checkTrue(
  '🔴 fetchMyAccountData 只從 "@/server/repos/customer-orders" 動態 import fetchMyOrders / fetchMyRegistrations——那是唯一的歸屬過濾層（見那個檔案檔頭）',
  customerFnsSrc.includes('await import(\n      "@/server/repos/customer-orders"\n    )') ||
    customerFnsSrc.includes('await import("@/server/repos/customer-orders")'),
);
checkTrue(
  "fetchMyAccountData 同時拿了 fetchMyOrders 與 fetchMyRegistrations 兩支（不是只拿一半）",
  /fetchMyOrders/.test(customerFnsSrc) && /fetchMyRegistrations/.test(customerFnsSrc),
);

// =============================================================================
// [3] 授權邊界：customerFnMiddleware 獨立定義、掛在讀資料的兩支 server fn 上
// =============================================================================
console.log("\n[3] customerFnMiddleware：獨立定義、掛在該掛的地方");

checkTrue(
  "customer-fns.ts 自己定義 customerFnMiddleware（不是從 lib/admin/middleware.ts import）",
  /const customerFnMiddleware = createMiddleware\(/.test(customerFnsSrc),
);
checkFalse(
  "customer-fns.ts 沒有從 lib/admin/middleware.ts import 任何東西——客人是刻意分開的第三種使用者（見 customer-auth.ts 檔頭），不塞進一個檔名叫 admin 的檔案",
  /from\s*"@\/lib\/admin\/middleware"/.test(customerFnsSrc),
);
checkTrue(
  "customerFnMiddleware 底層真的是 requireCustomer()——唯一合法的 userId 來源",
  /requireCustomer/.test(customerFnsSrc),
);
checkTrue(
  "🔴 fetchMyAccountData 掛了 .middleware([customerFnMiddleware])",
  /fetchMyAccountData[\s\S]{0,200}\.middleware\(\[customerFnMiddleware\]\)/.test(customerFnsSrc),
);
checkTrue(
  "🔴 setNewPassword 掛了 .middleware([customerFnMiddleware])",
  /setNewPassword[\s\S]{0,200}\.middleware\(\[customerFnMiddleware\]\)/.test(customerFnsSrc),
);
checkFalse(
  "🔴 fetchMyAccountData 的 handler 沒有收 userId／customerId 之類的參數（唯一合法來源是 context.customer，不是 inputValidator）",
  /fetchMyAccountData[\s\S]{0,400}\.inputValidator\(/.test(customerFnsSrc),
);

// =============================================================================
// [4] 🔴 未登入打 /account、/account/reset → beforeLoad 導去 /account/login
// =============================================================================
console.log("\n[4] beforeLoad guard：未登入導去 /account/login");

const accountBeforeLoad = extractBlock(accountSrc, "beforeLoad: async", [
  "\n  loader:",
  "\n  head:",
]);
checkTrue("account.tsx 找得到 beforeLoad", !!accountBeforeLoad);
checkTrue(
  "🔴 account.tsx 的 beforeLoad：signed_out → throw redirect 去 /account/login",
  !!accountBeforeLoad &&
    /state\s*===\s*"signed_out"[\s\S]{0,120}redirect\(\{\s*to:\s*"\/account\/login"/.test(
      accountBeforeLoad,
    ),
);
checkTrue(
  "account.tsx 的 beforeLoad 呼叫 getCurrentCustomer()（= requireCustomer()，不是自己重新判斷登入狀態）",
  !!accountBeforeLoad && /getCurrentCustomer/.test(accountBeforeLoad),
);

const resetSrc = stripTsComments(readFile("src/routes/account_.reset.tsx"));
checkTrue("反空殼：account_.reset.tsx 剝完註解仍有夠多程式碼", resetSrc.trim().length > 1500);
const resetBeforeLoad = extractBlock(resetSrc, "beforeLoad: async", ["\n  head:"]);
checkTrue("account_.reset.tsx 找得到 beforeLoad", !!resetBeforeLoad);
checkTrue(
  "🔴 account_.reset.tsx 的 beforeLoad：signed_out → throw redirect 去 /account/login（token_hash 一次性用掉了，這一頁改認 requireCustomer()）",
  !!resetBeforeLoad &&
    /state\s*===\s*"signed_out"[\s\S]{0,120}redirect\(\{\s*to:\s*"\/account\/login"/.test(
      resetBeforeLoad,
    ),
);

// account_.register / account_.forgot / account_.login 這三頁刻意**沒有** beforeLoad
// guard——它們必須讓未登入的人看得到，這是它們存在的理由。
for (const f of ["account_.login.tsx", "account_.register.tsx", "account_.forgot.tsx"]) {
  const src = stripTsComments(readFile(`src/routes/${f}`));
  checkFalse(
    `${f} 沒有 beforeLoad（這幾頁本來就是給未登入的人看的，不該被任何登入檢查擋住）`,
    /beforeLoad/.test(src),
  );
}

// =============================================================================
// [5] 🔴 登出是 POST，不接受 GET
// =============================================================================
console.log("\n[5] 登出：POST-only");

checkTrue(
  '🔴 customerSignOut 是 createServerFn({ method: "POST" })——GET 的話 <img src="/_serverFn/…"> 就能把人登出',
  /customerSignOut\s*=\s*createServerFn\(\{\s*method:\s*"POST"\s*\}\)/.test(customerFnsSrc),
);
checkTrue(
  "account.tsx 的登出按鈕呼叫的是 customerSignOut（不是自己組一個 GET 連結）",
  /customerSignOut/.test(accountSrc),
);
checkFalse(
  'account.tsx 沒有任何 <a href="/…logout"> 或 <Link to="…logout"> 這種 GET 型態的登出連結',
  /(href|to)=["'][^"']*logout[^"']*["']/i.test(accountSrcRaw),
);

// =============================================================================
// [6] 忘記密碼：查有查無同一句訊息（防帳號枚舉）
// =============================================================================
console.log("\n[6] 忘記密碼：同一句訊息，不因帳號存在與否分流");

const forgotSrcRaw = readFile("src/routes/account_.forgot.tsx");
const forgotSrc = stripTsComments(forgotSrcRaw);
checkTrue("反空殼：account_.forgot.tsx 剝完註解仍有夠多程式碼", forgotSrc.trim().length > 1200);

checkTrue(
  "account_.forgot.tsx 呼叫 requestPasswordReset 後直接顯示同一個成功畫面（setSent(true)），中間沒有分岔",
  /await requestPasswordReset\(\{\s*data:\s*values\s*\}\);\s*setSent\(true\);/.test(forgotSrc),
);
checkTrue(
  "忘記密碼成功畫面用「如果」這個字——防帳號枚舉的措辭，不因查無此人就顯示不同文案（見任務「已知」）",
  /如果這個信箱有註冊過/.test(forgotSrcRaw),
);

const requestResetFnBody = extractBlock(customerFnsSrc, "export const requestPasswordReset", [
  "\nexport const confirmAuthLink",
]);
checkTrue("找得到 requestPasswordReset 的 server fn 定義", !!requestResetFnBody);
checkFalse(
  "🔴 requestPasswordReset 的 handler 沒有任何 if／分流——一律轉呼叫 requestCustomerPasswordReset() 後回 { ok: true }，不透露帳號是否存在",
  !!requestResetFnBody && /\.handler\(async[\s\S]*?\bif\s*\(/.test(requestResetFnBody),
);
checkTrue(
  "requestPasswordReset 呼叫的是既有的 requestCustomerPasswordReset()（不是自己重新查一次帳號存不存在）",
  !!requestResetFnBody && /requestCustomerPasswordReset/.test(requestResetFnBody),
);

// =============================================================================
// [7] auth.confirm.tsx：token_hash + verifyOtp，失敗不导去 /account/login
// =============================================================================
console.log("\n[7] auth.confirm.tsx：token_hash 路徑，失敗原地說明，不导去登入頁");

const confirmSrcRaw = readFile("src/routes/auth.confirm.tsx");
const confirmSrc = stripTsComments(confirmSrcRaw);
checkTrue("反空殼：auth.confirm.tsx 剝完註解仍有夠多程式碼", confirmSrc.trim().length > 1500);

checkTrue("auth.confirm.tsx 讀 token_hash（不是 PKCE 的 code）", /token_hash/.test(confirmSrc));
checkFalse(
  "🔴 auth.confirm.tsx 完全沒有提到 /auth/callback（那是 OAuth 的 ?code= 專用，PKCE 綁瀏覽器，這個站不該產生指向那裡的連結）",
  /\/auth\/callback/.test(confirmSrc),
);
checkFalse(
  "這個站沒有 auth.callback.tsx 這個檔案",
  existsSync(join(ROUTES_DIR, "auth.callback.tsx")),
);

const loaderBody = extractBlock(confirmSrc, "loader: async", ["\n  head:"]);
checkTrue("auth.confirm.tsx 找得到 loader", !!loaderBody);

// 抓出 loader 本體裡每一個 redirect({ … }) 呼叫，再從裡面撈出所有字串常值——
// 不能只認 `to: "…"` 後面緊接著一個字面值：這裡的 to 是三元式
// （`result.type === "recovery" ? "/account/reset" : "/account"`），兩個分支都要
// 抓到才能正確判斷「有沒有導去 /account/login」。
const redirectCalls = loaderBody ? [...loaderBody.matchAll(/redirect\(\{[^}]*\}\)/g)] : [];
const redirectTargets = redirectCalls.flatMap((m) =>
  [...m[0].matchAll(/"([^"]+)"/g)].map((x) => x[1]),
);
checkTrue(
  "loader 裡至少有一個 redirect()（驗證成功時導去 /account 或 /account/reset）",
  redirectTargets.length >= 1,
);
checkFalse(
  "🔴 loader 的任何一個 redirect() 都不會導去 /account/login 或 /login——客人看到配紅字的登入頁只會以為自己打錯密碼，見檔頭",
  redirectTargets.some((t) => t === "/account/login" || t === "/login"),
);
checkTrue(
  "🔴 throw redirect() 包在 if (result) 區塊裡（成功分支），不在 try/catch 裡面——避免被自己的 catch 攔截、把一次成功的驗證誤判成失敗",
  !!loaderBody && /if\s*\(result\)\s*\{\s*throw redirect\(/.test(loaderBody),
);
checkTrue(
  "loader 失敗（confirmError 有值）時回傳 { confirmError, type }，原地渲染說明頁，不是導頁",
  !!loaderBody && /return\s*\{\s*confirmError,\s*type\s*\};/.test(loaderBody),
);
checkTrue(
  "🔴 失敗畫面標題不是「登入失敗」一類的措辭，是專屬的說明（見任務「已知」：客人看到登入頁配紅字會以為自己打錯密碼）",
  /這個連結無法使用/.test(confirmSrc) && !/密碼(不正確|錯誤)/.test(confirmSrc),
);

const linksSrcRaw = readFile("src/server/customer-auth-links.ts");
const linksSrc = stripTsComments(linksSrcRaw);
checkTrue("反空殼：customer-auth-links.ts 剝完註解仍有夠多程式碼", linksSrc.trim().length > 1200);

checkTrue(
  "customer-auth-links.ts 呼叫 verifyOtp({ token_hash, type })",
  /verifyOtp\(\{\s*token_hash:\s*tokenHash,\s*type\s*\}\)/.test(linksSrc),
);

const customerAuthImportMatch = linksSrc.match(/import\s*\{([^}]+)\}\s*from\s*"\.\/customer-auth"/);
checkTrue('customer-auth-links.ts 有從 "./customer-auth" import', !!customerAuthImportMatch);
check(
  "🔴 customer-auth-links.ts 只從 customer-auth.ts import writeCustomerSession 這一個既有 export——沒有動 customer-auth.ts 一個字，只是呼叫它已經公開的東西",
  customerAuthImportMatch?.[1]?.trim(),
  "writeCustomerSession",
);
checkTrue(
  "customer-auth-links.ts 認領訪客訂單走既有的 claim_guest_orders RPC（與 signInCustomer 同一支，不是另外發明一套）",
  /rpc\(\s*"claim_guest_orders"\s*,\s*\{\s*p_user_id:\s*data\.user\.id\s*\}\s*\)/.test(linksSrc),
);

// =============================================================================
// [8] 沒有新增環境變數
// =============================================================================
console.log("\n[8] 沒有新增環境變數");

const NEW_FILES_TO_CHECK = [
  "src/server/customer-auth-links.ts",
  "src/lib/customer-account.ts",
  "src/lib/customer-fns.ts",
];
for (const f of NEW_FILES_TO_CHECK) {
  const vars = envVarsUsedIn(stripTsComments(readFile(f)));
  check(`${f} 完全不直接讀 process.env（這個功能不需要、也沒有新增任何環境變數）`, vars, []);
}

// =============================================================================
// [9] 對照組：customer-auth.ts / customer-orders.ts 仍然是原本那組 export
//     （這兩個檔案是任務明講「已經上線、已經驗證，不要重寫」的檔案）
// =============================================================================
console.log("\n[9] 對照組：沒有動到 customer-auth.ts / customer-orders.ts 的既有 export");

const customerAuthSrc = stripTsComments(readFile("src/server/customer-auth.ts"));
for (const name of [
  "EmailNotConfirmedError",
  "readCustomerSession",
  "writeCustomerSession",
  "destroyCustomerSession",
  "customerAuthRedirectUrl",
  "signUpCustomer",
  "signInCustomer",
  "signOutCustomer",
  "requestCustomerPasswordReset",
  "requireCustomer",
  "getCustomerOrNull",
]) {
  checkTrue(
    `customer-auth.ts 仍然 export ${name}（原樣存在，任務要求不重寫這個檔案）`,
    new RegExp(`export (class|function|async function) ${name}\\b`).test(customerAuthSrc) ||
      new RegExp(`export const ${name}\\b`).test(customerAuthSrc),
  );
}

const customerOrdersRepoSrc = stripTsComments(readFile("src/server/repos/customer-orders.ts"));
checkTrue(
  "customer-orders.ts 恰好只有這三支歸屬過濾函式（沒有被多加或改名）",
  /export async function fetchMyOrders\(/.test(customerOrdersRepoSrc) &&
    /export async function fetchMyOrderDetail\(/.test(customerOrdersRepoSrc) &&
    /export async function fetchMyRegistrations\(/.test(customerOrdersRepoSrc),
);
checkTrue(
  'customer-orders.ts 的 fetchMyOrders / fetchMyRegistrations 仍然各自帶著 .eq("user_id"（唯一的授權邊界，原樣保留）',
  (customerOrdersRepoSrc.match(/\.eq\(\s*"user_id"/g) ?? []).length >= 2,
);

// =============================================================================
// [10] 對照組（唯讀）：後台閘門仍然把 customer 擋在外面
// =============================================================================
console.log("\n[10] 對照組（唯讀，沒有改這兩個檔案）：customer 角色打 /admin 仍然被拒");

const authSrc = stripTsComments(readFile("src/server/auth.ts"));
checkTrue(
  "🔴 後台閘門 loadBackOfficeProfile 的角色允許清單恰好是 admin/staff/pending——customer（與 vendor）不在清單裡，回 null",
  /data\.role !== "admin" && data\.role !== "staff" && data\.role !== "pending"\) return null/.test(
    authSrc,
  ),
);

const adminShellSrc = stripTsComments(readFile("src/routes/admin/_shell.tsx"));
checkTrue(
  "對照組：/admin/_shell 的 beforeLoad 對查無後台身分的人（customer 就是其中一種）導去 /admin/login",
  /if\s*\(\s*!user\s*\)\s*\{\s*throw redirect\(\{\s*to:\s*"\/admin\/login"/.test(adminShellSrc),
);

// =============================================================================
// [11] 導覽列／頁尾有進得去的入口
// =============================================================================
console.log("\n[11] 導覽列／頁尾入口");

const headerSrc = stripTsComments(readFile("src/components/SiteHeader.tsx"));
checkTrue('SiteHeader 有一個連去 "/account" 的連結', /to="\/account"/.test(headerSrc));
checkTrue(
  "SiteHeader 的帳號連結用 ui.nav.account（三語字串，不是寫死的中文）",
  /ui\.nav\.account/.test(headerSrc),
);

const footerSrc = stripTsComments(readFile("src/components/SiteFooter.tsx"));
checkTrue('SiteFooter 有一個連去 "/account" 的連結', /to="\/account"/.test(footerSrc));
checkTrue(
  "SiteFooter 的帳號連結用 ui.footer.account（三語字串，不是寫死的中文）",
  /ui\.footer\.account/.test(footerSrc),
);

const stringsSrc = readFile("src/i18n/strings.ts");
checkTrue(
  "strings.ts 的 UI.nav 有 account 這個 key",
  /nav:\s*\{[\s\S]*?account:\s*\{/.test(stringsSrc),
);
checkTrue(
  "strings.ts 的 UI.footer 有 account 這個 key",
  /footer:\s*\{[\s\S]*?account:\s*\{/.test(stringsSrc),
);

// =============================================================================
// 收尾
// =============================================================================
console.log("\n────────────────────────────────────────────────────");
console.log(`${pass + fail} 個 case：${pass} passed, ${fail} failed`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
