#!/usr/bin/env node
/**
 * same-as-buyer-selftest.mjs —— /checkout 第一位參加者的「同購買人」勾選框
 *
 * 這一期加的東西很小（一個 checkbox），但它的壞法全都是**看起來正常**的那一種：
 *
 *   (a) 勾的當下複製一次，之後回上面改電話 → 參加者停在舊電話。畫面上沒有任何
 *       異狀，客人也不會再檢查一次那三格。
 *   (b) 取消勾選時把值清掉 → 「不小心點到」變成「資料沒了」。
 *   (c) 把 noticeAck 一起自動勾起來 → 替別人簽了同意，而資料庫存的是
 *       event_registrations.notice_ack_at（一個時間戳），那個時間戳會變成謊話。
 *   (d) 勾選狀態變成表單值／進了購物車 → 送出的形狀變了，或第三人的姓名電話被
 *       persist() 寫進 localStorage。
 *   (e) 第二位以後也長出勾選框 → 「同購買人」對第二位沒有意義。
 *
 * 所以這一支分三段，而且**三段互相獨立**：
 *
 *   [靜態] 讀原始碼與 AST。守的是「不可以出現」那一類（勾選狀態不在表單值裡、
 *          effect 沒有寫 noticeAck、沒有清空分支）。**永遠會跑。**
 *
 *   [渲染] 用 esbuild 打包真正的 ParticipantFields，用 react-dom/server 渲染成 HTML。
 *          守的是「渲染出來的結構」：只有第一位有那個框、勾起來時那三格是 readOnly、
 *          noticeAck 不受影響。**永遠會跑**（打不起來是紅，不是 skip）。
 *
 *   [瀏覽器] 把同一個元件（外加真正的 useForm + 真正的 zod schema + 真正的購物車
 *          store）打包成瀏覽器 bundle，在無頭 chromium 裡**真的打字、真的點擊**。
 *          這一段是唯一驗得到「勾選狀態下改上方聯絡資料，參加者跟著變」的：
 *          useEffect 在 react-dom/server 底下永遠不執行，靜態渲染看不到它。
 *
 * ⚠️ 瀏覽器段需要 playwright 的 chromium 已經下載好（`npx playwright install chromium`）。
 *    沒有的話會**大聲跳過**並列在收尾的略過清單裡 —— 與 event-registration-selftest
 *    的併發段同一個處理方式。CI 上 `npm ci` 不會下載瀏覽器，所以那裡跑的是前兩段。
 *
 * 執行：node scripts/same-as-buyer-selftest.mjs  （或 npm test）
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";
import { parse as parseJs } from "@babel/parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/same-as-buyer-selftest.mjs";

const PARTICIPANT_FIELDS = "src/components/shop/ParticipantFields.tsx";
const CHECKOUT_ROUTE = "src/routes/checkout.index.tsx";
const EVENT_ROUTE = "src/routes/events.$slug.tsx";
const CART_LIB = "src/lib/cart.ts";
const CHECKOUT_LIB = "src/lib/checkout.ts";

// -----------------------------------------------------------------------------
// 迷你測試框架（與 event-detail-page-selftest 同一套）
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

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

function checkDeep(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${b}`));
    console.log(red(`      實得 ${a}`));
  }
}

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串 —— 見 run-selftests.mjs 的「守門 4」。
 * 這一支底下有大量 `check("…沒有 X", src.includes("X"), false)` 形狀的否定斷言，
 * 空字串會讓它們全部靜默通過。
 */
const readFile = (p) => {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) {
    throw new Error(
      `selftest 讀不到檔案：${abs}` +
        "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串 —— 回空字串會讓所有" +
        "「確認原始碼裡沒有 X」的否定斷言靜默通過。）",
    );
  }
  return readFileSync(abs, "utf8");
};

/**
 * `@/` 是 tsconfig 的 alias，Node 不認得。這一支最後會 `await import()`
 * **產線那支 src/lib/checkout.ts 本人**（不是複製一份 schema 來比），所以要先補上
 * 解析規則。與 scripts/direct-checkout-selftest.mjs 同一招。
 *
 * checkout.ts 在 runtime 只 import zod 與 @/lib/invoice-format（`@/i18n/types` 是
 * type-only，Node 的型別剝離會直接拿掉），所以不需要任何 stub。
 */
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      const base = join(ROOT, "src", spec.slice(2));
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
});

// 守著 readFile() 自己。
{
  const ghost = "__same-as-buyer-missing-file-probe__";
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

/**
 * 拿掉註解。
 *
 * 🔴 這一支的斷言幾乎每一條都在找關鍵字，而這一期的原始碼裡**註解本身就寫滿了
 *    那些關鍵字**（「不要把 noticeAck 加進來」「不清空」「不進 localStorage」）。
 *    不剝註解的話，一個把 effect 整段刪掉、只留註解的改動會讓每一條斷言照樣綠 ——
 *    這正是這個 repo 出過的假陽性形狀之一（斷言被旁邊的註解餵飽）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const participantSrcRaw = readFile(PARTICIPANT_FIELDS);
const participantSrc = stripComments(participantSrcRaw);
const checkoutRouteSrc = stripComments(readFile(CHECKOUT_ROUTE));
const eventRouteRaw = readFile(EVENT_ROUTE);
const cartSrc = stripComments(readFile(CART_LIB));
const checkoutLibSrc = stripComments(readFile(CHECKOUT_LIB));

// 反空殼：剝完註解還要有夠多程式碼，否則底下每一條否定斷言都是假性通過。
checkTrue("反空殼：ParticipantFields.tsx 剝完註解仍有程式碼", participantSrc.length > 2000);
checkTrue("反空殼：checkout.index.tsx 剝完註解仍有程式碼", checkoutRouteSrc.length > 10000);
checkTrue("反空殼：events.$slug.tsx 讀得到", eventRouteRaw.length > 5000);
checkTrue("反空殼：cart.ts 剝完註解仍有程式碼", cartSrc.length > 4000);
checkTrue("反空殼：checkout.ts 剝完註解仍有程式碼", checkoutLibSrc.length > 8000);
// 對照組：剝註解真的有剝到。ParticipantFields 檔頭那句只出現在註解裡。
checkFalse(
  "對照組：stripComments 真的拿掉了註解（檔頭那句話不在剝完的字串裡）",
  participantSrc.includes("最順手的做法是把它們掛在 CartLine 上"),
);
checkTrue(
  "對照組：那句話在未剝註解的原文裡（證明上一條不是因為讀錯檔）",
  participantSrcRaw.includes("最順手的做法是把它們掛在 CartLine 上"),
);

// =============================================================================
// [1] 勾選狀態不進表單值、不進購物車、不進 localStorage
// =============================================================================
console.log("\n[1] 勾選狀態住在哪裡");

// 表單值會被 `{...values}` 整包送進 placeOrder()。多一個 key 就是改了送出的形狀。
checkFalse(
  "🔴 CheckoutFormValues / checkout.ts 完全沒有 sameAsBuyer",
  checkoutLibSrc.includes("sameAsBuyer"),
);
checkFalse("🔴 cart.ts 完全沒有 sameAsBuyer", cartSrc.includes("sameAsBuyer"));
// 對照組：這兩支檔案確實是拿來比對的那兩支（有它們該有的東西）。
checkTrue(
  "對照組：checkout.ts 裡有 participantSchema",
  checkoutLibSrc.includes("participantSchema"),
);
checkTrue("對照組：cart.ts 裡有 persist(", cartSrc.includes("persist("));

// 勾選狀態由路由用 useState 持有。
checkTrue(
  "checkout.index.tsx 用 useState 持有 sameAsBuyer",
  /const \[sameAsBuyer, setSameAsBuyer\] = useState\(false\)/.test(checkoutRouteSrc),
);
checkFalse(
  "🔴 checkout.index.tsx 沒有把 sameAsBuyer 塞進 defaultValues",
  /defaultValues:[\s\S]*?sameAsBuyer[\s\S]*?\n  \}\)/.test(checkoutRouteSrc),
);
// ParticipantFields 也不可以自己 setValue 到一個叫 sameAsBuyer 的表單路徑。
checkFalse(
  "ParticipantFields 沒有 setValue 到 sameAsBuyer 路徑",
  /setValue\(\s*["'`][^"'`]*sameAsBuyer/.test(participantSrc),
);
// 兩個檔案都不碰 localStorage。
checkFalse("ParticipantFields 不碰 localStorage", participantSrc.includes("localStorage"));
checkFalse("checkout.index.tsx 不碰 localStorage", checkoutRouteSrc.includes("localStorage"));
// 對照組：真的有人碰 localStorage（cart.ts），所以上面兩條不是因為關鍵字寫錯。
checkTrue("對照組：cart.ts 確實有 localStorage", cartSrc.includes("localStorage"));

// =============================================================================
// [1b] 🔴 /checkout 真的把這個功能接上去了
// =============================================================================
console.log("\n[1b] /checkout 的接線（沒有這一段，功能可以整個沒接上而測試全綠）");

/**
 * 🔴 這一段是這支測試最容易漏掉的地方。
 *
 * 底下 [3] 與 [5] 都是自己搭 harness 把 ParticipantFields 渲染起來的 —— harness 自己
 * 會把 sameAsBuyer / onSameAsBuyerChange 傳進去，所以**就算 /checkout 根本沒有傳這兩個
 * prop**，那兩段一樣全綠，而真正的結帳頁上連那個框都不會出現。這幾條守的就是那個縫。
 */
checkTrue(
  "🔴 checkout.index.tsx 把 sameAsBuyer 傳給第一組（idx === 0），其餘傳 undefined",
  /sameAsBuyer=\{idx === 0 \? sameAsBuyer : undefined\}/.test(checkoutRouteSrc),
);
checkTrue(
  "🔴 checkout.index.tsx 把 setSameAsBuyer 傳給第一組（idx === 0），其餘傳 undefined",
  /onSameAsBuyerChange=\{idx === 0 \? setSameAsBuyer : undefined\}/.test(checkoutRouteSrc),
);
// 對照組：那個 map 真的存在（不是因為整段被刪掉才「找不到別的接法」）。
checkTrue(
  "對照組：checkout.index.tsx 仍然用 participantSlots.map 渲染 ParticipantFields",
  /participantSlots\.map\(\(slot, idx\) => \(\s*<ParticipantFields/.test(checkoutRouteSrc),
);

/**
 * ParticipantFields 是靠**欄位名字**（customerName / customerEmail / customerPhone）
 * useWatch 到購買人資料的。/checkout 上那三格一旦改名，連動就會靜默斷掉 ——
 * 元件不會報錯，畫面上那三格只是永遠帶入空字串。
 */
for (const field of ["customerName", "customerEmail", "customerPhone"]) {
  checkTrue(
    `🔴 /checkout 的聯絡資料仍然叫 ${field}（ParticipantFields 靠這個名字訂閱）`,
    new RegExp(`name="${field}"`).test(checkoutRouteSrc),
  );
}

// =============================================================================
// [2] 同步的相依 —— 用 AST 檢查 useEffect 的相依陣列
// =============================================================================
console.log("\n[2] useEffect 的相依陣列（AST，不是 grep）");

/**
 * 為什麼要拆 AST 而不是 regex：相依陣列是這一期唯一決定「會不會跟著變」的東西，
 * 而它長得像一段人畜無害的清單。少掉 buyerPhone，程式碼仍然編得過、畫面仍然正常、
 * 勾起來仍然會帶入 —— 只有「勾完再回上面改電話」這一條路徑會壞，而那正是使用者
 * 最常走的那一條。regex 抓 `buyerPhone` 會被同一個檔案裡別處的出現餵飽（例如
 * setValue 的參數），所以要真的找到那個 ArrayExpression。
 */
const participantAst = parseJs(participantSrcRaw, {
  sourceType: "module",
  plugins: ["typescript", "jsx"],
});

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

/** 所有 useEffect(fn, [deps]) 的呼叫，連同相依名稱與 callback 的原始碼片段。 */
const effects = [];
walk(participantAst.program, (n) => {
  if (n.type !== "CallExpression") return;
  if (n.callee?.type !== "Identifier" || n.callee.name !== "useEffect") return;
  const [cb, deps] = n.arguments;
  const names =
    deps?.type === "ArrayExpression"
      ? deps.elements.map((e) => (e?.type === "Identifier" ? e.name : `<${e?.type}>`))
      : null;
  effects.push({
    deps: names,
    body: cb ? participantSrcRaw.slice(cb.start, cb.end) : "",
  });
});

check("ParticipantFields 裡剛好一個 useEffect", effects.length, 1);
const syncEffect = effects[0] ?? { deps: [], body: "" };
checkTrue("那個 useEffect 有相依陣列（不是省略）", Array.isArray(syncEffect.deps));
for (const dep of ["linked", "buyerName", "buyerEmail", "buyerPhone"]) {
  checkTrue(
    `🔴 相依陣列包含 ${dep}（少一個就退化成「只在勾的當下複製一次」）`,
    (syncEffect.deps ?? []).includes(dep),
  );
}
checkTrue("相依陣列包含 setValue", (syncEffect.deps ?? []).includes("setValue"));

// 三個值都必須是 useWatch 訂閱來的。用 getValues() 讀是「讀一次快照」，不會重新
// render，相依陣列寫得再漂亮也不會再跑一次。
for (const [name, field] of [
  ["buyerName", "customerName"],
  ["buyerEmail", "customerEmail"],
  ["buyerPhone", "customerPhone"],
]) {
  checkTrue(
    `${name} 由 useWatch 訂閱 ${field}（不是 getValues 讀快照）`,
    new RegExp(`const ${name} = useWatch\\(\\{\\s*control,\\s*name: "${field}"\\s*\\}\\)`).test(
      participantSrc,
    ),
  );
}
checkFalse(
  "🔴 ParticipantFields 沒有用 getValues() 讀購買人資料",
  /getValues\(/.test(participantSrc),
);

// effect 的本體：只寫 name / email / phone 三格，而且**不寫 noticeAck**。
const effectBody = stripComments(syncEffect.body);
checkTrue("effect 會寫 participants.0.name", effectBody.includes('"participants.0.name"'));
checkTrue("effect 會寫 participants.0.email", effectBody.includes('"participants.0.email"'));
checkTrue("effect 會寫 participants.0.phone", effectBody.includes('"participants.0.phone"'));
checkFalse(
  "🔴 effect **不**寫 participants.0.noticeAck（同意不能替人勾）",
  effectBody.includes("noticeAck"),
);
check("effect 一共只呼叫三次 setValue", (effectBody.match(/setValue\(/g) ?? []).length, 3);
// 取消勾選時不清空：effect 在 linked 為 false 時直接 return，本體裡沒有任何
// 「寫空字串進參加者欄位」的分支。
checkTrue(
  "linked 為 false 時 effect 直接 return（不做任何事）",
  /if \(!linked\) return;/.test(effectBody),
);
checkFalse(
  '🔴 effect 沒有「setValue(…, "")」這種清空寫法',
  /setValue\([^)]*,\s*""/.test(effectBody),
);
// 對照組：effect 本體真的切出來了（不是空字串讓上面三條否定斷言白過）。
checkTrue("對照組：切得出 effect 本體", effectBody.length > 120);

// =============================================================================
// [3] 渲染出來的結構（react-dom/server，永遠會跑）
// =============================================================================
console.log("\n[3] 真渲染：誰有勾選框、勾起來長什麼樣");

const CACHE_DIR = join(ROOT, "node_modules/.cache/same-as-buyer-selftest");
mkdirSync(CACHE_DIR, { recursive: true });

/** 共用的假資料，兩段（渲染／瀏覽器）都用同一份，才比得出「一模一樣」。 */
const LINE_KEY = "11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
const BUYER = { name: "王小明", email: "wang@example.com", phone: "0912345678" };
const BUYER2 = { name: "李小華", email: "lee@example.org", phone: "0987654321" };

let ssrMod = null;
let ssrErr = null;
try {
  const { build } = await import("esbuild");
  const outfile = join(CACHE_DIR, "ssr-entry.mjs");
  await build({
    stdin: {
      contents: `
        import { renderToStaticMarkup } from "react-dom/server";
        import { useForm, FormProvider } from "react-hook-form";
        import { LanguageProvider } from "@/i18n/LanguageContext";
        import { ParticipantFields } from "@/components/shop/ParticipantFields";

        function Harness({ defaults, blocks }) {
          const form = useForm({ defaultValues: defaults });
          return (
            <FormProvider {...form}>
              {blocks.map((b, i) => (
                <ParticipantFields
                  key={i}
                  lineTitle={{ zh: "測試活動", en: "Test event", ja: "テスト" }}
                  sessionTitle={null}
                  startIndex={b.startIndex}
                  count={b.count}
                  sameAsBuyer={b.sameAsBuyer}
                  onSameAsBuyerChange={b.wired ? () => {} : undefined}
                />
              ))}
            </FormProvider>
          );
        }

        export const renderBlocks = (defaults, blocks) =>
          renderToStaticMarkup(
            <LanguageProvider>
              <Harness defaults={defaults} blocks={blocks} />
            </LanguageProvider>,
          );`,
      resolveDir: ROOT,
      loader: "tsx",
      sourcefile: "same-as-buyer-ssr-entry.tsx",
    },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    target: "node22",
    logLevel: "silent",
    absWorkingDir: ROOT,
    alias: { "@": join(ROOT, "src") },
    define: { "process.env.NODE_ENV": '"production"' },
    // react / react-dom 留給 node 自己解析（打包 CJS 版的 react-dom 會炸在 require
    // 墊片上）。輸出寫在 node_modules/.cache 底下，所以那兩個 bare specifier 解析得到。
    external: ["react", "react-dom", "react/jsx-runtime", "react-dom/server"],
    // react-hook-form 的相依裡有 CJS，esbuild 產出的 ESM 會留下 require() ——
    // 沒有這個墊片就會炸在「Dynamic require of "react" is not supported」。
    banner: {
      js:
        'import { createRequire as __selftestCreateRequire } from "node:module";\n' +
        "const require = __selftestCreateRequire(import.meta.url);",
    },
  });
  ssrMod = await import(pathToFileURL(outfile).href);
} catch (err) {
  ssrErr = err;
}
checkTrue(
  "🔴 ParticipantFields 打包 + 渲染得起來（打不起來是紅，不是 skip）",
  ssrMod !== null && typeof ssrMod.renderBlocks === "function",
);
if (ssrErr) console.log(red(`      ${String(ssrErr).slice(0, 600)}`));

const SAME_AS_BUYER_ZH = "同購買人（帶入上方聯絡資料）";
const HINT_ZH = "這三格會跟著上方的聯絡資料自動更新";

if (ssrMod) {
  const seat = (name = "", email = "", phone = "") => ({
    lineKey: LINE_KEY,
    name,
    email,
    phone,
    noticeAck: false,
  });
  const defaults = (seats) => ({
    customerName: BUYER.name,
    customerEmail: BUYER.email,
    customerPhone: BUYER.phone,
    participants: seats,
  });

  // ── (a) 第一組、勾選關閉 ──────────────────────────────────────────────
  const offHtml = ssrMod.renderBlocks(defaults([seat("張三", "z@example.com", "0911111111")]), [
    { startIndex: 0, count: 1, sameAsBuyer: false, wired: true },
  ]);
  // ── (b) 第一組、勾選開啟（表單值已經是購買人的資料，effect 在 SSR 不跑） ──
  const onHtml = ssrMod.renderBlocks(defaults([seat(BUYER.name, BUYER.email, BUYER.phone)]), [
    { startIndex: 0, count: 1, sameAsBuyer: true, wired: true },
  ]);
  // ── (c) 一組兩位 ──────────────────────────────────────────────────────
  const twoHtml = ssrMod.renderBlocks(defaults([seat(), seat()]), [
    { startIndex: 0, count: 2, sameAsBuyer: true, wired: true },
  ]);
  // ── (d) 第二組（startIndex=2）—— 即使 props 全都傳了也不該有框 ─────────
  const secondBlockHtml = ssrMod.renderBlocks(defaults([seat(), seat(), seat()]), [
    { startIndex: 2, count: 1, sameAsBuyer: true, wired: true },
  ]);
  // ── (e) 第一組但沒接 handler（/checkout 給第二行以後的樣子）────────────
  const unwiredHtml = ssrMod.renderBlocks(defaults([seat()]), [
    { startIndex: 0, count: 1, sameAsBuyer: undefined, wired: false },
  ]);

  const countOf = (html, needle) => html.split(needle).length - 1;

  // 反空殼：渲染結果得是真的表單，否則底下每一條「不該出現」都是假性通過。
  for (const [label, html] of [
    ["勾選關閉", offHtml],
    ["勾選開啟", onHtml],
    ["一組兩位", twoHtml],
    ["第二組", secondBlockHtml],
    ["沒接 handler", unwiredHtml],
  ]) {
    checkTrue(
      `反空殼：${label} 渲染出真的欄位（含姓名 label 與 input）`,
      html.length > 400 && html.includes("姓名") && html.includes("<input"),
    );
  }

  // ── 只有第一位有勾選框 ────────────────────────────────────────────────
  check("第一組第一位：有 1 個「同購買人」", countOf(offHtml, SAME_AS_BUYER_ZH), 1);
  check(
    "🔴 一組兩位：仍然只有 1 個「同購買人」（第二位沒有）",
    countOf(twoHtml, SAME_AS_BUYER_ZH),
    1,
  );
  check(
    "🔴 startIndex=2 的那一組：0 個「同購買人」（就算 props 全傳了）",
    countOf(secondBlockHtml, SAME_AS_BUYER_ZH),
    0,
  );
  check("沒有 onSameAsBuyerChange 就不渲染那個框", countOf(unwiredHtml, SAME_AS_BUYER_ZH), 0);
  // 對照組：那一組確實有渲染出兩位／一位參加者。
  // ⚠️ 需求是「第 n 位參加者」那個小標題，不是任何含「位參加者」的字 ——
  //    contactHint 裡的「聯絡得到這位參加者」會讓後者每一位多數一次。
  const seatHeadings = (html) => (html.match(/第 \d+ 位參加者/g) ?? []).length;
  check("一組兩位：真的有兩個「第 n 位參加者」小標", seatHeadings(twoHtml), 2);
  check("startIndex=2 的那一組：有一位參加者", seatHeadings(secondBlockHtml), 1);

  // ── 勾起來的狀態長什麼樣 ──────────────────────────────────────────────
  // ⚠️ 數 checked 要數 aria-checked="true"，不是 data-state="checked" —— Radix 的
  //    Indicator（打勾那個 <span>）也帶著同一個 data-state，一個勾起來的 checkbox 會
  //    被數成兩個。aria-checked 只出現在 role="checkbox" 的那顆按鈕上。
  check('勾選開啟：checkbox 是 aria-checked="true"', countOf(onHtml, 'aria-checked="true"'), 1);
  check("勾選關閉：沒有任何 checkbox 是 checked", countOf(offHtml, 'aria-checked="true"'), 0);
  checkTrue("勾選開啟：出現「這三格會跟著…自動更新」的說明", onHtml.includes(HINT_ZH));
  checkFalse("勾選關閉：不出現那句說明", offHtml.includes(HINT_ZH));

  // 三格 readOnly —— 這是「看得出來是被帶入的」那一條。readOnly 不是 disabled：
  // 唯讀的輸入框仍然對得到焦點、選得起來、值照樣進表單。
  // （react-dom/server 印出來的是 `readOnly=""` 這個大小寫；瀏覽器那一段驗的是真正的
  //   DOM property，兩邊各驗一次。）
  check("🔴 勾選開啟：三格都是 readOnly", countOf(onHtml, 'readOnly=""'), 3);
  check("勾選關閉：沒有任何一格 readOnly", countOf(offHtml, 'readOnly=""'), 0);
  check(
    "🔴 一組兩位、勾選開啟：只有前三格 readOnly（第二位仍可編輯）",
    countOf(twoHtml, 'readOnly=""'),
    3,
  );
  checkTrue("勾選開啟：三格有帶入的視覺提示（bg-muted）", onHtml.includes("bg-muted"));
  checkFalse("勾選關閉：沒有那個視覺提示", offHtml.includes("bg-muted"));
  // 值真的印在 input 上（對照組：證明上面數 readonly 的那三格就是這三格）。
  for (const v of [BUYER.name, BUYER.email, BUYER.phone]) {
    checkTrue(`勾選開啟：input 上印著購買人的「${v}」`, onHtml.includes(`value="${v}"`));
  }

  // ── noticeAck 不受影響 ────────────────────────────────────────────────
  const NOTICE_ZH = "我已閱讀並同意活動注意事項";
  check("勾選開啟：注意事項同意欄還在", countOf(onHtml, NOTICE_ZH), 1);
  check("一組兩位：兩位各自有一個注意事項同意欄", countOf(twoHtml, NOTICE_ZH), 2);
  // 勾選開啟時 checkbox 只有一個是 checked —— 那個是「同購買人」，不是 noticeAck。
  check(
    "🔴 勾選開啟：整份 HTML 只有 1 個 checked 的 checkbox（noticeAck 沒有被連帶勾起來）",
    countOf(onHtml, 'aria-checked="true"'),
    1,
  );
  check(
    "🔴 一組兩位、勾選開啟：一樣只有 1 個 checked（兩位的 noticeAck 都沒被勾）",
    countOf(twoHtml, 'aria-checked="true"'),
    1,
  );
  // 對照組：那兩個 noticeAck 真的存在而且是 unchecked（不是「根本沒渲染出來」）。
  check(
    "一組兩位：有 3 個 checkbox（1 同購買人 + 2 noticeAck）",
    countOf(twoHtml, 'role="checkbox"'),
    3,
  );
  check("一組兩位：其中 2 個是 unchecked", countOf(twoHtml, 'aria-checked="false"'), 2);
}

// =============================================================================
// [4] 活動頁的人數說明（三語齊全）
// =============================================================================
console.log("\n[4] 活動頁：調人數可以幫朋友一起報名");

const eventAst = parseJs(eventRouteRaw, { sourceType: "module", plugins: ["typescript", "jsx"] });
let quantityHint = null;
walk(eventAst.program, (n) => {
  if (n.type !== "ObjectProperty") return;
  const key = n.key?.name ?? n.key?.value;
  if (key !== "quantityHint") return;
  if (n.value?.type !== "ObjectExpression") return;
  const out = {};
  for (const p of n.value.properties) {
    if (p.type !== "ObjectProperty") continue;
    const k = p.key?.name ?? p.key?.value;
    if (p.value?.type === "StringLiteral") out[k] = p.value.value;
  }
  quantityHint = out;
});

checkTrue("PAGE.quantityHint 存在，而且是物件字面值", quantityHint !== null);
for (const lang of ["zh", "en", "ja"]) {
  checkTrue(
    `quantityHint.${lang} 是非空字串`,
    typeof quantityHint?.[lang] === "string" && quantityHint[lang].trim().length > 0,
  );
}
// 🔴 三語不可以互相重複。useT() 是 `entry[lang] || entry.zh` —— 把 en 留空會讓英文
//    畫面印中文，而那在型別上完全合法。抄一份中文貼到 en 也是同一個下場。
if (quantityHint) {
  checkTrue("quantityHint 三語互不相同", new Set(Object.values(quantityHint)).size === 3);
  checkTrue("quantityHint.zh 是中文", /[一-鿿]/.test(quantityHint.zh ?? ""));
  checkTrue(
    "quantityHint.en 是英文（沒有中日文字）",
    /^[^぀-ヿ一-鿿]+$/.test(quantityHint.en ?? ""),
  );
  checkTrue("quantityHint.ja 有日文假名", /[぀-ヿ]/.test(quantityHint.ja ?? ""));
  // 說明的內容要真的在講「多帶一個人」這件事，不是隨便一句話。
  checkTrue("quantityHint.zh 提到人數／朋友", /人數/.test(quantityHint.zh ?? ""));
}

// 有定義還要真的被渲染出來 —— 一個定義了卻沒有人用的文案就是沒有這句話。
const eventRouteStripped = stripComments(eventRouteRaw);
checkTrue(
  "🔴 quantityHint 真的被 render（t(PAGE.quantityHint) 出現在 JSX 裡）",
  /\{t\(PAGE\.quantityHint\)\}/.test(eventRouteStripped),
);
// 而且要貼著人數選擇器。用**結構**判斷，不是字元距離：字元距離會被無關的排版改動
// 推翻，而「中間有沒有插進別的段落」才是「這句話還貼著那個 stepper 嗎」的真正答案。
const stepperIdx = eventRouteStripped.indexOf("<QuantityStepper");
const hintIdx = eventRouteStripped.indexOf("{t(PAGE.quantityHint)}");
const noteIdx = eventRouteStripped.indexOf("PAGE.registerNote");
// 這一句自己那個 <p> 的開頭，不是它的文字位置 —— 不然「中間有沒有 <p」永遠會被
// 它自己的開標籤答成有。
const hintPIdx = eventRouteStripped.lastIndexOf("<p ", hintIdx);
checkTrue("QuantityStepper 找得到", stepperIdx > 0);
checkTrue("既有的 registerNote 那一行還在（對照座標）", noteIdx > 0);
checkTrue("說明在人數選擇器之後", hintIdx > stepperIdx);
checkTrue("🔴 說明排在既有的 registerNote 之前（是 stepper 底下第一句）", hintIdx < noteIdx);
checkTrue("切得出說明自己的 <p 開標籤", hintPIdx > stepperIdx);
checkFalse(
  "🔴 人數選擇器與這句說明之間沒有插進別的段落（<p）",
  eventRouteStripped.slice(stepperIdx, hintPIdx).includes("<p "),
);
checkFalse(
  "人數選擇器與這句說明之間沒有換到別的區塊（<section / <fieldset）",
  /<section|<fieldset/.test(eventRouteStripped.slice(stepperIdx, hintPIdx)),
);

// =============================================================================
// [5] 瀏覽器：真的打字、真的點擊
// =============================================================================
console.log("\n[5] 無頭 chromium：勾選 → 帶入 → 改上面 → 跟著變 → 取消 → 留著");

let chromium = null;
let browserWhy = "";
try {
  const pw = await import("playwright");
  const exe = pw.chromium.executablePath();
  if (existsSync(exe)) chromium = pw.chromium;
  else browserWhy = `chromium 執行檔不存在：${exe}`;
} catch (err) {
  browserWhy = `載入 playwright 失敗：${String(err).slice(0, 200)}`;
}

if (!chromium) {
  skipped.push(`瀏覽器互動段（${browserWhy}）`);
  console.log(yellow(`  ⤼ 跳過：${browserWhy}`));
  console.log(
    yellow(
      "     這一段是唯一驗得到「勾選狀態下改上方聯絡資料，參加者跟著變」的：\n" +
        "     useEffect 在 react-dom/server 底下不執行，[3] 的靜態渲染看不到它。\n" +
        "     本機補跑：npx playwright install chromium && node " +
        SELF,
    ),
  );
} else {
  const { build } = await import("esbuild");
  const bundlePath = join(CACHE_DIR, "browser-entry.js");
  await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { useEffect, useState } from "react";
        import { useForm } from "react-hook-form";
        import { zodResolver } from "@hookform/resolvers/zod";
        import { LanguageProvider } from "@/i18n/LanguageContext";
        import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
        import { Input } from "@/components/ui/input";
        import { ParticipantFields } from "@/components/shop/ParticipantFields";
        import { checkoutFormSchemaWithParticipants } from "@/lib/checkout";
        import { useCart } from "@/lib/cart";

        const LINE_KEY = ${JSON.stringify(LINE_KEY)};
        const zh = (entry) => entry.zh;

        /**
         * 這個 harness 刻意用**產線上真正的那幾支**：ParticipantFields、useForm +
         * zodResolver(checkoutFormSchemaWithParticipants)、以及真正的購物車 store。
         * 聯絡資料三格的 name 與 /checkout 一模一樣（customerName/Email/Phone）——
         * ParticipantFields 是靠這三個名字 useWatch 的，名字對不上就什麼都不會發生。
         */
        function Harness() {
          const [sameAsBuyer, setSameAsBuyer] = useState(false);
          const schema = checkoutFormSchemaWithParticipants({
            t: zh,
            requireAddress: false,
            participantSlots: [{ lineKey: LINE_KEY, count: 2 }],
          });
          const form = useForm({
            resolver: zodResolver(schema),
            defaultValues: {
              customerName: "",
              customerEmail: "",
              customerPhone: "",
              shippingMethod: "none",
              address: null,
              note: "",
              participants: [
                { lineKey: LINE_KEY, name: "", email: "", phone: "", noticeAck: false },
                { lineKey: LINE_KEY, name: "", email: "", phone: "", noticeAck: false },
              ],
              invoice: {
                type: "personal",
                taxId: "",
                companyTitle: "",
                carrierType: "",
                carrierNumber: "",
                loveCode: "",
              },
            },
          });
          useEffect(() => {
            window.__harness = {
              values: () => JSON.parse(JSON.stringify(form.getValues())),
              validate: () => form.trigger(),
            };
          }, [form]);
          const text = (name, label) => (
            <FormField
              control={form.control}
              name={name}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{label}</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                </FormItem>
              )}
            />
          );
          return (
            <LanguageProvider>
              <Form {...form}>
                <form onSubmit={(e) => e.preventDefault()}>
                  {text("customerName", "姓名")}
                  {text("customerEmail", "電子信箱")}
                  {text("customerPhone", "手機號碼")}
                  <ParticipantFields
                    lineTitle={{ zh: "測試活動", en: "Test event", ja: "テスト" }}
                    sessionTitle={null}
                    startIndex={0}
                    count={2}
                    sameAsBuyer={sameAsBuyer}
                    onSameAsBuyerChange={setSameAsBuyer}
                  />
                </form>
              </Form>
            </LanguageProvider>
          );
        }

        // 真的往購物車放一行，讓 persist() 真的寫進 localStorage —— 之後才驗得到
        // 「參加者資料沒有跟著進去」不是因為根本沒有人在寫 localStorage。
        useCart.getState().addItem({
          productId: "11111111-1111-4111-8111-111111111111",
          sessionId: "22222222-2222-4222-8222-222222222222",
          sessionTitle: { zh: "上午場", en: "Morning", ja: "午前" },
          sessionStartsAt: "2026-10-01T02:00:00.000Z",
          slug: "test-event",
          title: { zh: "測試活動", en: "Test event", ja: "テスト" },
          productType: "event",
          price: 500,
          compareAtPrice: null,
          qty: 2,
          limit: 10,
          imageKey: null,
        });

        createRoot(document.getElementById("root")).render(<Harness />);`,
      resolveDir: ROOT,
      loader: "tsx",
      sourcefile: "same-as-buyer-browser-entry.tsx",
    },
    outfile: bundlePath,
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    target: "es2022",
    logLevel: "silent",
    absWorkingDir: ROOT,
    alias: { "@": join(ROOT, "src") },
    define: { "process.env.NODE_ENV": '"production"' },
  });

  const bundle = readFileSync(bundlePath, "utf8");
  checkTrue("🔴 瀏覽器 bundle 打得起來（含 React 與元件）", bundle.length > 100000);

  const browser = await chromium.launch({ headless: true });
  // 🔴 locale 要指定。LanguageProvider 的 detectInitial() 讀 navigator.language，
  //    無頭 chromium 預設是 en-US —— 不指定的話畫面會切成英文，而下面每一條找中文
  //    字串的斷言都會找不到（第一次寫的時候就是這樣紅的）。
  const context = await browser.newContext({ locale: "zh-TW" });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  /**
   * 🔴 用 route 攔一個假網址，不是 page.setContent()。
   *
   * setContent 出來的文件是 about:blank，也就是 opaque origin —— 讀 localStorage 會直接
   * 丟 SecurityError，而 zustand 的 persist 會把那個例外吞掉。結果是「localStorage 裡
   * 沒有參加者資料」這一條**在一個根本沒有 localStorage 的頁面上**通過，什麼都沒驗到。
   * 給它一個真的 http origin，購物車才會真的寫進去，那條斷言才有意義。
   */
  const HARNESS_URL = "http://same-as-buyer.selftest.invalid/";
  const html =
    "<!doctype html><html><head><meta charset=utf-8></head><body><div id=root></div>" +
    `<script>${bundle.replace(/<\/script>/g, "<\\/script>")}</script></body></html>`;
  await page.route(`${HARNESS_URL}**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  const load = async () => {
    await page.goto(HARNESS_URL, { waitUntil: "load" });
    await page.waitForSelector('input[name="participants.1.name"]', { timeout: 15000 });
  };
  await load();
  check("頁面沒有 runtime error", consoleErrors.length, 0);
  if (consoleErrors.length) console.log(red(`      ${consoleErrors[0].slice(0, 400)}`));
  checkTrue(
    "對照組：這個頁面真的存取得到 localStorage（不是 opaque origin）",
    await page.evaluate(() => {
      try {
        localStorage.setItem("__probe__", "1");
        const ok = localStorage.getItem("__probe__") === "1";
        localStorage.removeItem("__probe__");
        return ok;
      } catch {
        return false;
      }
    }),
  );

  const P0 = {
    name: 'input[name="participants.0.name"]',
    email: 'input[name="participants.0.email"]',
    phone: 'input[name="participants.0.phone"]',
  };
  const P1 = {
    name: 'input[name="participants.1.name"]',
    email: 'input[name="participants.1.email"]',
    phone: 'input[name="participants.1.phone"]',
  };
  const BUYER_SEL = {
    name: 'input[name="customerName"]',
    email: 'input[name="customerEmail"]',
    phone: 'input[name="customerPhone"]',
  };
  /**
   * 等一個條件成立，**逾時不丟例外**。
   *
   * 逾時就丟例外的話，一個「同步壞掉」的改動會讓這一支在半路 crash —— exit code 仍然
   * 是紅的，但畫面上看不到是哪一條斷言掛了，只看得到一段 playwright 的 stack。
   * 這裡吞掉逾時，讓下一行的 checkDeep 自己把「期望什麼、實得什麼」印出來。
   */
  const settle = async (fn, arg) => {
    try {
      await page.waitForFunction(fn, arg, { timeout: 5000 });
    } catch {
      /* 下一條斷言會報告實際值 */
    }
  };

  const read = async (sel) => page.inputValue(sel);
  const readTriple = async (sel) => ({
    name: await read(sel.name),
    email: await read(sel.email),
    phone: await read(sel.phone),
  });
  const fillBuyer = async (who) => {
    await page.fill(BUYER_SEL.name, who.name);
    await page.fill(BUYER_SEL.email, who.email);
    await page.fill(BUYER_SEL.phone, who.phone);
  };

  /**
   * 「同購買人」那個框從**它的 label** 找回來（不是「第一個 checkbox」那種位置依賴的
   * 找法）。順帶把 a11y 也驗掉了：那句話必須是一個 <label for>，而且真的指到一個
   * 存在的控制項 —— 沒有的話，用讀屏或點文字的人根本切不動這個開關。
   */
  const labelInfo = await page.evaluate((txt) => {
    const labels = [...document.querySelectorAll("label")].filter(
      (l) => l.textContent.trim() === txt,
    );
    const target = labels[0] ? document.getElementById(labels[0].htmlFor) : null;
    return {
      count: labels.length,
      forId: labels[0]?.htmlFor ?? null,
      targetRole: target?.getAttribute("role") ?? null,
    };
  }, SAME_AS_BUYER_ZH);
  check("🔴 畫面上只有 1 個「同購買人」（一組兩位，第二位沒有）", labelInfo.count, 1);
  check('「同購買人」的 label 指到一個 role="checkbox" 的控制項', labelInfo.targetRole, "checkbox");

  // label 壞掉時的退路：noticeAck 那兩個是包在 <FormControl> 裡的，一定帶
  // aria-describedby；「同購買人」不是表單欄位，所以沒有。有退路是為了讓「label 沒接好」
  // 只紅上面那一條，而不是讓整段在下一行 click 的時候 crash、把後面所有斷言一起帶走。
  const SAME_BOX = labelInfo.forId
    ? `button[role="checkbox"][id="${labelInfo.forId}"]`
    : 'button[role="checkbox"]:not([aria-describedby])';
  const ACK_BOX = labelInfo.forId
    ? `button[role="checkbox"]:not([id="${labelInfo.forId}"])`
    : 'button[role="checkbox"][aria-describedby]';
  check(
    "畫面上一共 3 個 checkbox（同購買人 + 兩位的 noticeAck）",
    (await page.$$('button[role="checkbox"]')).length,
    3,
  );
  check("其中 1 個是同購買人", (await page.$$(SAME_BOX)).length, 1);
  check("其餘 2 個是兩位參加者的 noticeAck", (await page.$$(ACK_BOX)).length, 2);

  // ── (1) 先填聯絡資料，再勾 ────────────────────────────────────────────
  await fillBuyer(BUYER);
  const beforeCheck = await readTriple(P0);
  checkDeep("對照組：還沒勾之前第一位是空的（證明底下的值真的是勾出來的）", beforeCheck, {
    name: "",
    email: "",
    phone: "",
  });

  await page.click(SAME_BOX);
  await settle((sel) => document.querySelector(sel)?.value === "王小明", P0.name);
  checkDeep("🔴 勾選 → 三格帶入聯絡資料", await readTriple(P0), BUYER);
  checkDeep(
    "🔴 勾選 → 表單狀態（送出用的那一份）也帶入了",
    (await page.evaluate(() => window.__harness.values())).participants[0],
    {
      lineKey: LINE_KEY,
      name: BUYER.name,
      email: BUYER.email,
      phone: BUYER.phone,
      noticeAck: false,
    },
  );
  checkDeep("第二位完全沒被動到", await readTriple(P1), { name: "", email: "", phone: "" });

  // 三格是 readOnly。
  const readOnlyOf = async (sel) => page.evaluate((s) => document.querySelector(s).readOnly, sel);
  checkTrue("勾選狀態下：姓名唯讀", await readOnlyOf(P0.name));
  checkTrue("勾選狀態下：信箱唯讀", await readOnlyOf(P0.email));
  checkTrue("勾選狀態下：手機唯讀", await readOnlyOf(P0.phone));
  checkFalse("第二位的姓名沒有變成唯讀", await readOnlyOf(P1.name));

  // ── (2) 🔴 勾著的時候回上面改 —— 這一條是整支測試的核心 ────────────────
  await fillBuyer(BUYER2);
  await settle((sel) => document.querySelector(sel)?.value === "李小華", P0.name);
  checkDeep("🔴 勾選狀態下改聯絡資料 → 第一位跟著變（畫面）", await readTriple(P0), BUYER2);
  checkDeep(
    "🔴 勾選狀態下改聯絡資料 → 表單狀態也跟著變（送出的那一份）",
    (await page.evaluate(() => window.__harness.values())).participants[0],
    {
      lineKey: LINE_KEY,
      name: BUYER2.name,
      email: BUYER2.email,
      phone: BUYER2.phone,
      noticeAck: false,
    },
  );
  // 逐格再驗一次：只改手機，另外兩格不該被牽動成別的值。
  await page.fill(BUYER_SEL.phone, "0922333444");
  await settle((sel) => document.querySelector(sel)?.value === "0922333444", P0.phone);
  checkDeep("只改手機 → 只有手機跟著變", await readTriple(P0), {
    ...BUYER2,
    phone: "0922333444",
  });

  // ── (3) 取消勾選 → 值留著，而且變回可編輯 ─────────────────────────────
  await page.click(SAME_BOX);
  await settle((sel) => document.querySelector(sel).readOnly === false, P0.name);
  checkDeep("🔴 取消勾選 → 已帶入的值留著（不清空）", await readTriple(P0), {
    ...BUYER2,
    phone: "0922333444",
  });
  checkFalse("取消勾選 → 姓名可以編輯了", await readOnlyOf(P0.name));
  // 取消之後上面再改，就不該再連動了。
  await page.fill(BUYER_SEL.name, "陳大文");
  await page.waitForTimeout(120);
  check("取消勾選後改聯絡資料 → 第一位不再跟著變", await read(P0.name), BUYER2.name);
  // 而且真的可以自己打字。
  await page.fill(P0.name, "自己打的名字");
  check("取消勾選後第一位可以自己編輯", await read(P0.name), "自己打的名字");

  // ── (4) noticeAck 全程沒有被替人勾 ────────────────────────────────────
  const ackStates = await page.$$eval(ACK_BOX, (els) =>
    els.map((e) => e.getAttribute("data-state")),
  );
  checkDeep("🔴 兩位的 noticeAck 全程都是 unchecked（沒有被自動勾）", ackStates, [
    "unchecked",
    "unchecked",
  ]);

  // ── (5) localStorage 裡沒有任何參加者資料 ─────────────────────────────
  const storage = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out[k] = localStorage.getItem(k);
    }
    return out;
  });
  const blob = JSON.stringify(storage);
  checkTrue(
    "對照組：購物車真的有寫進 localStorage（否則下面幾條是假性通過）",
    typeof storage["interval-books-cart"] === "string" &&
      storage["interval-books-cart"].includes("test-event"),
  );
  for (const [label, needle] of [
    ["購買人姓名", BUYER2.name],
    ["購買人信箱", BUYER2.email],
    ["手機", "0922333444"],
    ["自己打的參加者姓名", "自己打的名字"],
    ["勾選狀態的欄位名", "sameAsBuyer"],
  ]) {
    checkFalse(`🔴 localStorage 裡沒有${label}`, blob.includes(needle));
  }

  // ── (6) 🔴 送出的 payload 與手動填一模一樣 ────────────────────────────
  //
  // 「一模一樣」不是用眼睛比的：把兩種填法各自跑完，拿真正的 zod schema
  // （checkoutFormSchemaWithParticipants，就是 /checkout 綁的那一支）parse，再比
  // parse 出來的結果。形狀多一個 key、少一個 key、型別變了，這裡都會不一樣。
  const fresh = load;

  const fillSecondSeatAndAck = async () => {
    await page.fill(P1.name, "第二位");
    await page.fill(P1.email, "second@example.com");
    const acks = await page.$$(ACK_BOX);
    for (const a of acks) await a.click();
  };

  // (A) 用勾選框
  await fresh();
  await fillBuyer(BUYER);
  await page.click(SAME_BOX);
  await settle((sel) => document.querySelector(sel)?.value === "王小明", P0.name);
  await fillSecondSeatAndAck();
  const valuesChecked = await page.evaluate(() => window.__harness.values());
  const validChecked = await page.evaluate(() => window.__harness.validate());

  // (B) 手動填成一樣的內容
  await fresh();
  await fillBuyer(BUYER);
  await page.fill(P0.name, BUYER.name);
  await page.fill(P0.email, BUYER.email);
  await page.fill(P0.phone, BUYER.phone);
  await fillSecondSeatAndAck();
  const valuesManual = await page.evaluate(() => window.__harness.values());
  const validManual = await page.evaluate(() => window.__harness.validate());

  checkTrue("對照組：勾選那一份通過 zod 驗證", validChecked === true);
  checkTrue("對照組：手動那一份通過 zod 驗證", validManual === true);
  checkDeep("🔴 勾選填出來的表單值 === 手動填出來的表單值", valuesChecked, valuesManual);
  checkFalse(
    "🔴 表單值裡沒有 sameAsBuyer 這個 key（送出的形狀沒有變）",
    JSON.stringify(valuesChecked).includes("sameAsBuyer"),
  );
  check(
    "表單值的 top-level key 沒有多也沒有少",
    Object.keys(valuesChecked).sort().join(","),
    [
      "address",
      "customerEmail",
      "customerName",
      "customerPhone",
      "invoice",
      "note",
      "participants",
      "shippingMethod",
    ].join(","),
  );
  check("participants 仍然是 2 筆（等於數量）", valuesChecked.participants.length, 2);
  checkDeep(
    "每一位參加者的 key 就是 schema 那五個",
    valuesChecked.participants.map((p) => Object.keys(p).sort().join(",")),
    ["email,lineKey,name,noticeAck,phone", "email,lineKey,name,noticeAck,phone"],
  );

  await browser.close();

  // 兩份 payload 一樣，還要真的餵給產線那支 schema 看它 parse 出同一個東西。
  // （上面的 validate() 是瀏覽器裡的 resolver；這裡是 Node 直接 import 原始碼，
  //   兩條路徑獨立。）
  const checkoutMod = await import(pathToFileURL(join(ROOT, CHECKOUT_LIB)).href);
  const schema = checkoutMod.checkoutFormSchemaWithParticipants({
    t: (e) => e.zh,
    requireAddress: false,
    participantSlots: [{ lineKey: LINE_KEY, count: 2 }],
  });
  const parsedChecked = schema.safeParse(valuesChecked);
  const parsedManual = schema.safeParse(valuesManual);
  checkTrue("🔴 勾選那一份通過產線 schema", parsedChecked.success);
  if (!parsedChecked.success) {
    console.log(red(`      ${JSON.stringify(parsedChecked.error.issues).slice(0, 500)}`));
  }
  checkTrue("🔴 手動那一份通過產線 schema", parsedManual.success);
  checkDeep(
    "🔴 兩份 parse 出來的結果完全相同（送出的形狀沒有變）",
    parsedChecked.success ? parsedChecked.data : null,
    parsedManual.success ? parsedManual.data : null,
  );
}

// =============================================================================
console.log("\n────────────────────────────────────────────────────");
if (skipped.length > 0) {
  console.log(yellow(`略過 ${skipped.length} 段：`));
  for (const s of skipped) console.log(yellow(`  • ${s}`));
}
console.log(`${pass} passed, ${fail} failed`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
