#!/usr/bin/env node
/**
 * event-detail-page-selftest.mjs —— /events/$slug（活動詳情頁）的自檢
 *
 * ── 為什麼是新開一支，不是加進 event-registration-selftest ──────────────────
 * 那一支守的是 0020 的**報名管線**不變量（reserve_session_seat 的七步、名額的
 * 單一真相、event_registrations 的零 grant），而且它有一整段要連本機 PostgreSQL
 * 才跑得到。這一支守的是**一個公開路由的形狀**：檔名、三種讀取結果各自走到哪裡、
 * 有沒有讀到不存在的欄位。兩者失敗時要叫回來的人不同、要看的檔案不同，混在同一
 * 支 1400 行的檔案裡，往後只會讓「哪一條紅了代表什麼」愈來愈難回答。
 *
 * 這一支**完全靜態**：只讀原始碼，不連任何資料庫，所以在任何機器上都會跑。
 *
 * ── 🔴 這個 repo 出過三次假陽性，所以每一條斷言都先 stripTs() ───────────────
 * 斷言被**註解內容**餵飽是這裡最常見的失敗模式，而這個 repo 的檔頭特別長。具體
 * 例子就在這一期：src/routes/events.$slug.tsx 的檔頭寫著「imageFor(key, fallback)
 * 永遠會回一張圖」——「這一頁沒有呼叫 imageFor」這條斷言如果直接對整個檔案跑，
 * 會因為那句註解而**假性變紅**；反過來，「有渲染 <SessionList」如果對整個檔案跑，
 * 也可能被某句提到它的註解**假性變綠**。所以下面每一條都對 stripTs() 之後的
 * 程式碼跑，而且範圍能縮小就縮小（例如只對 fetchEventBySlug 的函式本體）。
 *
 * 執行：node scripts/event-detail-page-selftest.mjs（或 npm test）
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/event-detail-page-selftest.mjs";

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
  }
}

const checkTrue = (label, value) => check(label, Boolean(value), true);
const checkFalse = (label, value) => check(label, Boolean(value), false);

const readFile = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "");

/** 拿掉 TypeScript 的註解（`//` 整行與 `/* … *\/` 區塊）—— 見檔頭的假陽性說明。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** 切出一支 `export async function name(` 到下一個頂層 export 之間的本體。 */
function fnBody(code, name) {
  const start = code.indexOf(`export async function ${name}(`);
  if (start === -1) return "";
  const rest = code.slice(start + 1);
  const end = rest.indexOf("\nexport ");
  return rest.slice(0, end === -1 ? rest.length : end);
}

const ROUTE_DETAIL = "src/routes/events.$slug.tsx";
const ROUTE_INDEX = "src/routes/events.index.tsx";
const ROUTE_OLD = "src/routes/events.tsx";

const detailCode = stripTs(readFile(ROUTE_DETAIL));
const indexCode = stripTs(readFile(ROUTE_INDEX));
const cmsCode = stripTs(readFile("src/lib/cms.ts"));
const shopCode = stripTs(readFile("src/lib/shop.ts"));
const pickerCode = stripTs(readFile("src/components/shop/SessionPicker.tsx"));
const routeTree = readFile("src/routeTree.gen.ts");

// =============================================================================
// [1] 路由改名：不可以兩份並存
// =============================================================================
console.log("\n[1] 路由改名");
// flat routing 下留著 events.tsx 會讓它變成 /events 底下的 parent layout，
// 需要 <Outlet /> 才畫得出子路由 —— 沒有的話 /events/$slug 就是一片空白。
// repo 自己的慣例已經給了答案：沒有 shop.tsx，只有 shop.index.tsx + shop.$slug.tsx。
check(`${ROUTE_OLD} 不存在（改名真的完成了）`, existsSync(join(ROOT, ROUTE_OLD)), false);
checkTrue(`${ROUTE_INDEX} 存在`, existsSync(join(ROOT, ROUTE_INDEX)));
checkTrue(`${ROUTE_DETAIL} 存在`, existsSync(join(ROOT, ROUTE_DETAIL)));
// 對照組：同一組形狀的先例必須還在，否則上面兩條的「慣例」就沒有依據。
checkTrue("先例 shop.index.tsx 還在", existsSync(join(ROOT, "src/routes/shop.index.tsx")));
checkTrue("先例 shop.$slug.tsx 還在", existsSync(join(ROOT, "src/routes/shop.$slug.tsx")));
check("先例裡也沒有 shop.tsx", existsSync(join(ROOT, "src/routes/shop.tsx")), false);

// 反空殼：先證明兩個檔案真的有內容，否則底下每一條 test() 都是假性結果。
checkTrue("反空殼：events.$slug.tsx 讀得到程式碼", detailCode.length > 2500);
checkTrue("反空殼：events.index.tsx 讀得到程式碼", indexCode.length > 2500);

checkTrue('events.index.tsx 宣告成 "/events/"', /createFileRoute\("\/events\/"\)/.test(indexCode));
checkTrue(
  'events.$slug.tsx 宣告成 "/events/$slug"',
  /createFileRoute\("\/events\/\$slug"\)/.test(detailCode),
);
// 參數叫 $slug 不叫 $id 是刻意的：之後補 events.slug 時用 slug = id 回填，
// 今天發出去的網址仍然有效。
checkFalse("路由參數沒有寫成 $id", /createFileRoute\("\/events\/\$id"\)/.test(detailCode));

// =============================================================================
// [2] routeTree.gen.ts 跟著改名走，而且進了版控
// =============================================================================
console.log("\n[2] routeTree.gen.ts");
checkTrue("routeTree 是 tracked 檔案", existsSync(join(ROOT, "src/routeTree.gen.ts")));
checkTrue("反空殼：routeTree 讀得到", routeTree.length > 10000);
checkTrue("routeTree import 了 events.index", /from '\.\/routes\/events\.index'/.test(routeTree));
checkTrue("routeTree import 了 events.$slug", /from '\.\/routes\/events\.\$slug'/.test(routeTree));
// 舊的那一行必須消失 —— 留著就代表 routeTree 沒重新產生，部署上去會找不到檔案。
checkFalse("routeTree 不再 import 舊的 ./routes/events", /from '\.\/routes\/events'/.test(routeTree));
checkTrue("routeTree 有 /events/$slug 這條路由", routeTree.includes("'/events/$slug'"));

// =============================================================================
// [3] 三種讀取結果各自走到哪裡 —— 這一頁最容易做錯的一條
// =============================================================================
console.log("\n[3] 查無 / 讀取失敗 / 沒有場次，是三件事");
const bySlugBody = stripTs(fnBody(readFile("src/lib/cms.ts"), "fetchEventBySlug"));
checkTrue("切得出 fetchEventBySlug 的本體", bySlugBody.length > 400);

// (a) 查無此活動（或未發布）→ 真的 404。
checkTrue(
  "loader 只有在「查不到而且不是讀取失敗」時才 notFound()",
  /if \(!event && !unavailable\) throw notFound\(\);/.test(detailCode),
);
// 🔴 讀取失敗絕對不能 404。下面兩條把「唯一一次 notFound()」釘死：整個檔案只有
//    一處呼叫它，而且就是上面那一行帶著 !unavailable 的守衛。少了守衛，資料庫
//    眨一下眼就等於告訴搜尋引擎這場活動不存在。
check("整個路由只呼叫一次 notFound()", (detailCode.match(/notFound\(\)/g) ?? []).length, 1);
checkFalse(
  "沒有任何一處無條件 notFound()",
  /(^|[^!&\s])\s*throw notFound\(\);/m.test(detailCode.replace("if (!event && !unavailable) throw notFound();", "")),
);
// (b) 讀取失敗 → 頁殼 + 「暫時無法載入」，不是空白也不是 404。
checkTrue("讀取失敗有自己的分支", /if \(!event\) \{/.test(detailCode));
checkTrue("該分支渲染頁殼", /if \(!event\) \{[\s\S]{0,400}<PageShell>/.test(detailCode));
checkTrue("該分支顯示 unavailable 文案", /if \(!event\) \{[\s\S]{0,600}t\(PAGE\.unavailable\)/.test(detailCode));
checkFalse("讀取失敗的分支不是 return null", /if \(!event\) \{\s*return null;/.test(detailCode));

// (c) 資料層必須真的分得出這兩種結果，否則路由那條守衛沒有東西可以判斷。
checkTrue("cms.ts 匯出 fetchEventBySlug", /export async function fetchEventBySlug/.test(cmsCode));
checkTrue("回傳型別帶著 unavailable", /event: EventDetailEntry \| null;\s*unavailable: boolean;/.test(cmsCode));
checkTrue("查無此列時回 unavailable: false", /if \(!data\) return \{ event: null, unavailable: false \};/.test(bySlugBody));
checkTrue("錯誤時回 unavailable: true", /return \{ event: null, unavailable: true \};/.test(bySlugBody));
// 這一支不可以退回 bundled 的舊資料 —— 那等於把 0001 的種子當成現況印給客人看。
checkFalse("詳情頁不退回 FALLBACK_EVENTS", /FALLBACK_EVENTS/.test(bySlugBody));
// 也不可以借用本檔那個「把每一種失敗都吞成 null」的 select()。
checkFalse("沒有走會吞掉錯誤的 select() helper", /await select\(/.test(bySlugBody));

// =============================================================================
// [4] 只讀 public.events 真的有的欄位
// =============================================================================
console.log("\n[4] 不 select 不存在的欄位");
// 這個 repo 剛因為 select 了一個還沒套上正式庫的欄位（0025 的 speaker_id）
// 把整個活動後台弄掛 —— PostgREST 對此回 42703，整頁 500。
const selectMatch = /\.select\("([^"]*)"\)/.exec(bySlugBody);
checkTrue("找得到 fetchEventBySlug 的 select 字串", Boolean(selectMatch));
const selectedCols = (selectMatch?.[1] ?? "").split(",").map((c) => c.trim()).filter(Boolean);
// 正式庫 public.events 的欄位全集（0001 的 14 欄 + 0025 的 speaker_id）。
const EVENT_COLUMNS = new Set([
  "id", "title", "summary", "description", "display_date", "iso_date", "category",
  "external_url", "registration_type", "payment_enabled", "sort_order", "is_published",
  "created_at", "updated_at", "speaker_id",
]);
checkTrue("select 不是空的", selectedCols.length >= 6);
for (const col of selectedCols) {
  checkTrue(`select 的 "${col}" 是 events 真的有的欄位`, EVENT_COLUMNS.has(col));
}
// 這四個是最可能被想當然耳寫進去的：前兩個**根本不存在**，後兩個存在但
// 0025 還沒套上正式庫 / 這一期沒有人讀。
for (const ghost of ["slug", "image_key", "speaker_id", "payment_enabled"]) {
  check(`select 沒有帶到 ${ghost}`, selectedCols.includes(ghost), false);
}
// 網址吃的是 id，不是一個還不存在的 slug 欄位。
checkTrue('查詢條件是 .eq("id", slug)', /\.eq\("id", slug\)/.test(bySlugBody));
checkFalse('沒有寫成 .eq("slug", slug)', /\.eq\("slug", slug\)/.test(bySlugBody));

// =============================================================================
// [5] 沒有封面圖是刻意的
// =============================================================================
console.log("\n[5] 不呼叫 imageFor()");
// events 沒有 image_key，而 imageFor(key, fallback) **永遠**會回一張圖 ——
// 隨手帶一個不存在的 key 進去，得到的不是「沒有封面」，是每一場活動都長一樣的
// 灰框佔位。
checkFalse("路由沒有呼叫 imageFor()", /imageFor\(/.test(detailCode));
checkFalse("路由連 imageFor 都沒有 import", /from "@\/lib\/images"/.test(detailCode));
checkFalse("路由沒有 import 任何 @/assets 圖片", /from "@\/assets\//.test(detailCode));
checkFalse("head() 沒有硬塞 og:image", /"og:image"/.test(detailCode));
// 對照組：imageFor 這支函式本身還在，斷言才有意義（不是因為函式被刪掉才「沒呼叫」）。
checkTrue("imageFor 仍然存在於 src/lib/images.ts", /export function imageFor/.test(stripTs(readFile("src/lib/images.ts"))));
checkTrue("而列表頁仍然用得到它", /imageFor\(/.test(indexCode));

// =============================================================================
// [6] 場次區：空的時候要有文案，不是整塊消失
// =============================================================================
console.log("\n[6] 場次區與空狀態");
checkTrue("路由 import 了 SessionList", /import \{ SessionList \} from "@\/components\/shop\/SessionPicker";/.test(detailCode));
checkTrue("路由真的渲染 <SessionList", /<SessionList\b/.test(detailCode));
// 沒有商品就沒有場次（event_sessions 掛的是 product_id），但那時候要傳空陣列
// 讓元件畫空狀態，不是把整塊拿掉。
checkTrue("沒有商品時仍然傳空陣列進去", /<SessionList sessions=\{booking\.product\?\.sessions \?\? \[\]\} \/>/.test(detailCode));
checkTrue("SessionPicker.tsx 匯出 SessionList", /export function SessionList\(/.test(pickerCode));
checkTrue("SessionList 有空狀態文案", /COPY\.noPublicSessions/.test(pickerCode));
checkFalse("SessionList 不是空的時候 return null", /sessions\.length === 0[\s\S]{0,80}return null/.test(pickerCode));
// 不可以自己再算一次剩餘名額，也不可以自己再寫一份日期格式 —— 兩份就是
// 「商品頁與活動頁對同一場活動顯示不同的數字」。
checkTrue("SessionList 走共用的 remainingForSession", /remainingForSession\(session\)/.test(pickerCode));
checkFalse("路由沒有自己算剩餘名額", /remainingForSession/.test(detailCode));
checkFalse("路由沒有自己寫日期格式", /formatSessionWhen/.test(detailCode));
checkFalse("路由沒有自己 map 場次", /sessions\.map\(/.test(detailCode));
// 既有的 SessionPicker 不可以被這一期換掉 —— /shop/$slug 還在用它。
checkTrue("SessionPicker 本人還在", /export function SessionPicker\(/.test(pickerCode));

// =============================================================================
// [7] 報名按鈕：導過去，四種狀態都有畫面
// =============================================================================
console.log("\n[7] 報名按鈕");
checkTrue("讀 events.registration_type", /registrationType/.test(detailCode));
checkTrue("external 走 external_url", /kind: "external"; href: string/.test(detailCode));
checkTrue("internal 導到 /shop/$slug", /to="\/shop\/\$slug"/.test(detailCode));
checkTrue("internal 帶的是商品的 slug", /params=\{\{ slug: cta\.productSlug \}\}/.test(detailCode));
// 接不到商品時不可以導去一個會 404 的網址，要顯示狀態。
checkTrue("接不到商品時顯示「報名尚未開放」", /t\(PAGE\.notOpen\)/.test(detailCode));
// 「問不到」與「沒有」是兩件事：讀取失敗時說「尚未開放」是一句還不知道真假的話。
checkTrue("讀取失敗時另有文案", /t\(PAGE\.registrationUnavailable\)/.test(detailCode));
checkTrue(
  "unavailable 才走 unavailable 文案，其餘走 closed",
  /booking\.unavailable \? \{ kind: "unavailable" \} : \{ kind: "closed" \}/.test(detailCode),
);
checkTrue("external_url 是空字串時也不生一個空連結", /return href \? \{ kind: "external", href \} : \{ kind: "closed" \};/.test(detailCode));
// 商品要透過 (source_type, source_id) 找 —— 0004 就定義好、也是唯一存在的連結。
checkTrue("shop.ts 有 fetchActiveProductForEvent", /export async function fetchActiveProductForEvent/.test(shopCode));
const forEventBody = stripTs(fnBody(readFile("src/lib/shop.ts"), "fetchActiveProductForEvent"));
checkTrue("切得出 fetchActiveProductForEvent 的本體", forEventBody.length > 300);
checkTrue('用 source_type = "event" 過濾', /\.eq\("source_type", "event"\)/.test(forEventBody));
checkTrue("用 source_id 對上 events.id", /\.eq\("source_id", eventId\)/.test(forEventBody));
checkTrue("只拿上架中的商品", /\.eq\("status", "active"\)/.test(forEventBody));
// 同一場活動被建成兩件商品是資料錯誤，但不該讓公開頁整頁掛掉。
checkTrue("重複資料用 limit(1) 而不是 maybeSingle()", /\.limit\(1\)/.test(forEventBody));
checkFalse("沒有用 maybeSingle()", /maybeSingle\(\)/.test(forEventBody));
// 用 event.id 問，不是拿 params.slug 直接問 —— 今天兩者相等，補上 events.slug 之後就不是。
checkTrue("loader 用 event.id 去找商品", /fetchActiveProductForEvent\(event\.id\)/.test(detailCode));
checkFalse("沒有拿 params.slug 直接找商品", /fetchActiveProductForEvent\(params\.slug\)/.test(detailCode));

// =============================================================================
// [8] 不在這一頁重做第二個結帳入口
// =============================================================================
console.log("\n[8] 沒有第二個結帳入口");
// 結帳是一條真管線（cartInputFor → cart → checkout → 座位預留 → 金流 → 發票），
// 而它的數量上限取的是**選中那一場**的剩餘。第二個入口就是第二份那段邏輯。
for (const forbidden of ["cartInputFor", "useCart", "addItem", "QuantityStepper"]) {
  checkFalse(`路由沒有用到 ${forbidden}`, new RegExp(`\\b${forbidden}\\b`).test(detailCode));
}
checkFalse("路由沒有 import @/lib/cart", /from "@\/lib\/cart"/.test(detailCode));
// ⚠️ 不可以寫成「檔案裡不准出現 SessionPicker」：SessionList 就是從
//    "@/components/shop/SessionPicker" 這個路徑 import 進來的，那樣寫必定紅。
//    要釘的是「沒有 import 那個具名元件」與「沒有把它渲染出來」。
checkFalse(
  "路由沒有 import SessionPicker 這個元件",
  /import \{[^}]*\bSessionPicker\b[^}]*\} from/.test(detailCode),
);
checkFalse("路由沒有渲染 <SessionPicker", /<SessionPicker\b/.test(detailCode));
// 對照組：真正的入口還在 /shop/$slug，斷言才有意義。
checkTrue("唯一的結帳入口仍在 shop.$slug.tsx", /cartInputFor\(/.test(stripTs(readFile("src/routes/shop.$slug.tsx"))));

// =============================================================================
// [9] 三語文案：en 要真的是英文
// =============================================================================
console.log("\n[9] 三語文案");
checkTrue("PAGE 是頂層靜態常數", /^const PAGE = \{/m.test(detailCode));
checkTrue("有呼叫 useDocumentMeta", /useDocumentMeta\(\{/.test(detailCode));
const enValues = [...detailCode.matchAll(/\ben:\s*"([^"]*)"/g)].map((m) => m[1]);
checkTrue("找得到 en 字面值（至少 8 句）", enValues.length >= 8);
const CJK = /[぀-ヿ一-鿿]/;
for (const v of enValues) {
  checkFalse(`en 沒有塞中日文字 → "${v.slice(0, 32)}"`, CJK.test(v));
  checkTrue(`en 不是空字串 → "${v.slice(0, 32)}"`, v.trim().length > 0);
}
const zhValues = [...detailCode.matchAll(/\bzh:\s*"([^"]*)"/g)].map((m) => m[1]);
check("zh 與 en 句數一樣多", zhValues.length, enValues.length);
for (const v of zhValues) checkTrue(`zh 真的是中文 → "${v.slice(0, 20)}"`, CJK.test(v));
// description 是這一期才第一次有人渲染的欄位（0001 的欄位註解自承 "not rendered
// by any route yet"），而它是後台的多行輸入 —— 換行要留著。
checkTrue("description 用 whitespace-pre-line 渲染", /whitespace-pre-line[\s\S]{0,200}t\(event\.description\)/.test(detailCode));

// =============================================================================
// [10] 列表頁連得到詳情頁；沒有偷加 migration
// =============================================================================
console.log("\n[10] 入口與禁區");
checkTrue("列表頁連到 /events/$slug", /to="\/events\/\$slug"/.test(indexCode));
checkTrue("列表頁帶的是 events.id", /params=\{\{ slug: e\.id \}\}/.test(indexCode));
checkTrue("列表頁仍保留外部連結", /href=\{e\.externalUrl\}/.test(indexCode));

const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
// 這一期完全不動資料庫：0024／0025 都還沒能套上正式庫，不要再疊第三支。
check("migration 仍然是 25 支", migrations.length, 25);
check("最後一支仍是 0025", migrations[24], "0025_event_speaker.sql");
// src/server/repos/events.ts 的 speaker fallback 是過渡程式碼，有 artists-selftest
// 守著，這一期一個字都不准動。
const repoCode = readFile("src/server/repos/events.ts");
checkTrue("repos/events.ts 的 speaker fallback 還在", /speakerColumnPresent/.test(repoCode));
checkTrue("repos/events.ts 的 COLUMNS_BASE 還在", /const COLUMNS_BASE = COLUMNS\.replace/.test(repoCode));

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
