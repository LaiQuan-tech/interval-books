#!/usr/bin/env node
/**
 * 活動頁組裝器 D4 —— 三個區塊編輯器（§5 agenda／§8 info_row／§9 faq）與 §3 場次鏡子。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 這一支在守什麼
 * ═══════════════════════════════════════════════════════════════════════════
 * D3 留下四段 placeholder，D4 把它們填成真的。這一期最容易做錯而且**不會有任何錯誤
 * 訊息**的一處是巢狀 FormProvider：區塊編輯器裡的 LocalizedField 是從 useFormContext()
 * 拿 control 的，少了內層那一層 provider，它會綁到組裝器**主表單**的 control 上 ——
 * 打在區塊裡的字被寫進活動的欄位，兩邊剛好都有 title/body，所以連型別都是對的。
 *
 * 所以 [2] 用**真的 react-hook-form + 真的 React**跑一次「打字」，而且內建突變測試：
 * 同一段程式碼在「有內層 provider」與「沒有內層 provider」兩種樹底下各跑一次，
 * 後者必須把字寫進外層表單。一條沒有突變測試的隔離斷言證明不了任何事。
 *
 * ── 這支不能證明什麼（誠實講） ──────────────────────────────────────────────
 * /admin/* 在登入牆後面，而且 Node 這一側沒有 jsdom，所以**沒有任何一條斷言是「看過
 * 畫面」**。[2] 驗的是機制（巢狀 provider 會遮蔽），[3] 驗的是產線元件真的長那個形狀
 * （AST，掃全 src/，不釘死路徑）。兩條合起來才等於「產線上那個元件是隔離的」；
 * 單獨任何一條都不夠。
 *
 * ── 連線段 ────────────────────────────────────────────────────────────────
 * [連線] 需要一個**本機**測試庫（已經套過 0001–0028）：
 *
 *   EVENT_BLOCK_EDITOR_SELFTEST_PG_URL=postgres:///alice_0028_test \
 *     node scripts/event-block-editor-selftest.mjs
 *
 * ⚠️ 永遠不碰正式庫。沒設那個變數就整段 skip（會印出來，不會靜悄悄消失）。
 *
 * 執行：node scripts/event-block-editor-selftest.mjs（或 npm test）
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";
import { registerHooks } from "node:module";
import { parse as parseJs } from "@babel/parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/event-block-editor-selftest.mjs";
const PG_URL = process.env.EVENT_BLOCK_EDITOR_SELFTEST_PG_URL ?? "";

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      實得 ${a}`));
    console.log(red(`      應為 ${e}`));
  }
}

function checkTrue(label, value, extra = "") {
  if (value === true) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    if (extra) console.log(red(`      ${extra}`));
  }
}

const checkFalse = (label, value, extra = "") => checkTrue(label, !value, extra);

/**
 * 讀檔。**讀不到就丟例外，不回空字串** —— 回空字串會讓每一條「原始碼裡沒有 X」的
 * 否定斷言靜默通過（見 scripts/run-selftests.mjs 的「守門 4」）。
 */
const readFile = (p) => {
  const abs = p.startsWith("/") ? p : join(ROOT, p);
  if (!existsSync(abs)) {
    throw new Error(`selftest 讀不到檔案：${abs}（路徑打錯或檔案被搬走了。這裡刻意不回空字串。）`);
  }
  return readFileSync(abs, "utf8");
};

{
  const ghost = join(ROOT, "__event-block-editor-selftest-missing-probe__");
  let thrown = null;
  try {
    readFile(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 readFile() 讀不到檔案時丟例外（不是靜默回空字串）",
    thrown !== null && String(thrown.message).includes(ghost),
  );
}

function walkSrc(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walkSrc(abs, out);
    else if (/\.tsx?$/.test(abs)) out.push(abs);
  }
  return out;
}

/** 走 AST。刻意跳過 comments —— **註解不該餵飽任何斷言**。 */
function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walkAst(n, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    if (key === "innerComments" || key === "comments") continue;
    walkAst(node[key], visit);
  }
}

const parseTsx = (src, label) =>
  parseJs(src, { sourceType: "module", plugins: ["typescript", "jsx"], sourceFilename: label });

function jsxName(node) {
  const n = node?.openingElement?.name ?? node?.name;
  if (!n) return "";
  if (n.type === "JSXIdentifier") return n.name;
  if (n.type === "JSXMemberExpression") return `${jsxName({ name: n.object })}.${n.property.name}`;
  return "";
}

function jsxAttr(node, attrName) {
  const attrs = node?.openingElement?.attributes ?? [];
  return attrs.find((a) => a.type === "JSXAttribute" && a.name?.name === attrName) ?? null;
}

function jsxAttrString(node, attrName) {
  const a = jsxAttr(node, attrName);
  if (!a) return null;
  if (a.value?.type === "StringLiteral") return a.value.value;
  if (a.value?.type === "JSXExpressionContainer" && a.value.expression?.type === "StringLiteral") {
    return a.value.expression.value;
  }
  return null;
}

/** `<Foo {...bar}>` 裡那個 `bar`（可能有好幾個 spread，全回）。 */
function jsxSpreadNames(node) {
  return (node?.openingElement?.attributes ?? [])
    .filter((a) => a.type === "JSXSpreadAttribute" && a.argument?.type === "Identifier")
    .map((a) => a.argument.name);
}

const SRC_FILES = walkSrc(join(ROOT, "src"));

/**
 * 掃 src/ 找「誰 export 了這個名字」，而且要求**剛好一個檔**。
 *
 * 🔴 **不寫死路徑**。這個 repo 上一期才又發生過一次「斷言釘死單一檔案路徑，程式碼
 *    搬家之後靜默失去覆蓋」。0 個 → 被改名或刪掉了，底下的斷言全部失去意義；
 *    ≥2 個 → 有第二份了，「產線上跑的是這一份」立刻不成立。
 *
 * `export async function` 也要認得（repo 那一層每一支都是 async）。
 */
function findSoleDefiner(exportName) {
  const re = new RegExp(`export\\s+(?:const|(?:async\\s+)?function)\\s+${exportName}\\b`);
  const hits = SRC_FILES.filter((f) => re.test(readFileSync(f, "utf8")));
  check(
    `src/ 底下剛好一個檔 export ${exportName}`,
    hits.map((f) => relative(ROOT, f)),
    hits.length === 1 ? [relative(ROOT, hits[0])] : ["（剛好一個）"],
  );
  return hits.length === 1 ? hits[0] : null;
}

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

console.log("═══ 區塊編輯器自檢（D4 / §3 場次鏡子 + §5§8§9 三種區塊）═══");

// =============================================================================
// [0] 產線模組本人
// =============================================================================
console.log("\n[0] 產線模組（直接載入本人，不是複製品）");

const COPY_PATH = findSoleDefiner("EVENT_BLOCK_COPY");
const EDITOR_PATH = findSoleDefiner("EventBlockEditor");

/**
 * 資料層那一支**用「誰碰得到這張表」找出來**，不是寫死路徑，也不是用 export 的名字
 * 找（`reorderEventBlocks` 這個名字在 repo 與 server fn 兩層各有一個，那是對的 ——
 * fns 那一層本來就是同名的薄殼）。
 *
 * 「碰得到 public.event_blocks 的檔案剛好一個」本身就是這一期要守的東西：多一個，
 * 「排序只有一個家」立刻不成立。
 */
function filesTouchingTable(table) {
  const hits = [];
  for (const abs of SRC_FILES) {
    const rel = relative(ROOT, abs);
    let ast;
    try {
      ast = parseTsx(readFileSync(abs, "utf8"), rel);
    } catch (err) {
      fail += 1;
      console.log(red(`  ✗ ${rel} 解析失敗：${err.message}`));
      continue;
    }
    let touches = false;
    walkAst(ast.program, (n) => {
      if (n.type !== "CallExpression" || n.callee?.type !== "MemberExpression") return;
      if (n.callee.property?.name !== "from") return;
      const a0 = n.arguments[0];
      if (a0?.type === "StringLiteral" && a0.value === table) touches = true;
    });
    if (touches) hits.push(abs);
  }
  return hits;
}

const tableTouchers = filesTouchingTable("event_blocks");
check(
  "🔴 src/ 底下碰得到 public.event_blocks 的檔案剛好一個（排序才可能只有一個家）",
  tableTouchers.map((f) => relative(ROOT, f)),
  tableTouchers.length === 1 ? [relative(ROOT, tableTouchers[0])] : ["（剛好一個）"],
);
const REPO_PATH = tableTouchers.length === 1 ? tableTouchers[0] : null;

if (!COPY_PATH || !EDITOR_PATH || !REPO_PATH) {
  console.log(red("  ✗ 找不到唯一的產線模組，後面驗不下去"));
  console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail + 1}`);
  process.exit(1);
}

const vocab = await import(pathToFileURL(join(ROOT, "src/lib/event-blocks.ts")).href);
const copyMod = await import(pathToFileURL(COPY_PATH).href);
const schemas = await import(pathToFileURL(join(ROOT, "src/lib/admin/schemas.ts")).href);
const dirtyMod = await import(pathToFileURL(join(ROOT, "src/lib/admin/dirty-sections.ts")).href);

const { EVENT_BLOCK_KINDS } = vocab;
const { EVENT_BLOCK_COPY } = copyMod;
const { eventBlockSchema } = schemas;
const { markDirty, dirtyKeys, dirtyBannerText, hasDirty } = dirtyMod;

// =============================================================================
// [1] 一個編輯器 + 三組設定（不是三份複製，也不是一個誰都看不懂的抽象）
// =============================================================================
console.log("\n[1] 三種 kind 的文案表");

check(
  "🔴 文案表的 key 就是 EVENT_BLOCK_KINDS 那三個（執行期對帳，不是靠型別）",
  Object.keys(EVENT_BLOCK_COPY).sort(),
  [...EVENT_BLOCK_KINDS].sort(),
);

const COPY_REQUIRED = [
  "sectionTitle",
  "sectionDescription",
  "titleLabel",
  "bodyLabel",
  "emptyText",
  "addTitle",
];
for (const kind of EVENT_BLOCK_KINDS) {
  const c = EVENT_BLOCK_COPY[kind];
  checkTrue(
    `${kind}：六個必要文案都有而且不是空字串`,
    COPY_REQUIRED.every((k) => typeof c[k] === "string" && c[k].trim().length > 0),
    JSON.stringify(c),
  );
  checkTrue(`${kind}：bodyMultiline 是 boolean`, typeof c.bodyMultiline === "boolean");
}

/* 🔴 三種的欄位名必須**互不相同**。這一條在守的不是美觀：三種 kind 共用同一個元件，
   如果三組文案其實是同一組字，那「共用一個編輯器」就變成「三段長得一模一樣的東西，
   店家分不出哪一段是哪一段」—— 而那正是 0027 拒絕加 `feature` kind 的同一個理由。 */
for (const field of ["sectionTitle", "titleLabel", "bodyLabel", "addTitle"]) {
  check(
    `三種 kind 的 ${field} 互不重複`,
    new Set(EVENT_BLOCK_KINDS.map((k) => EVENT_BLOCK_COPY[k][field])).size,
    3,
  );
}

/* 🔴 文案表**只有文案**。一旦它開始放函式，就變成一個沒有名字的抽象層了 ——
   而「共用一個編輯器」與「做出一個誰都看不懂的抽象」的界線就在這裡。 */
const copyValueTypes = new Set(
  EVENT_BLOCK_KINDS.flatMap((k) => Object.values(EVENT_BLOCK_COPY[k]).map((v) => typeof v)),
);
check("🔴 文案表裡沒有函式（否則它就變成一個沒名字的抽象層了）", [...copyValueTypes].sort(), [
  "boolean",
  "string",
]);

// info_row 那一段要講出「不要在這裡寫金額」——0027 拒絕 pricing kind 的理由必須
// 出現在店家看得到的地方，不能只寫在 SQL 註解裡。
checkTrue(
  "🔴 info_row 的提示講出「金額的真相在商品售價」",
  EVENT_BLOCK_COPY.info_row.hint.includes("金額") &&
    EVENT_BLOCK_COPY.info_row.hint.includes("售價"),
  EVENT_BLOCK_COPY.info_row.hint,
);

// =============================================================================
// [2] 🔴 巢狀 FormProvider —— 用真的 React + 真的 react-hook-form 跑一次「打字」
// =============================================================================
console.log("\n[2] 巢狀 FormProvider（行為證明，內建突變測試）");

/**
 * 這一段做的事：
 *   · 建兩個**真的** useForm —— 外層是組裝器的主表單（有 title / slug），內層是區塊
 *     表單（有 title / body）。
 *   · 用 react-dom/server 把樹渲染出來，中間放一個 Probe：它跟 LocalizedField 一樣
 *     **只從 useFormContext() 拿 control**，然後 useController 註冊 `title.zh`。
 *   · 呼叫 `field.onChange("…")` —— 那就是使用者在輸入框裡打字時真正跑的那一行。
 *   · 然後看**外層**的 getValues()。
 *
 * 同一段程式碼跑兩次，差別只有 `nest`：
 *   nest=true  ＝ 產線的形狀（<Form {...blockForm}> 包著欄位）→ 外層必須乾淨。
 *   nest=false ＝ 把內層 provider 拿掉的突變 → 外層必須被污染。
 * 第二次是第一次的突變測試：如果沒有它，「外層乾淨」在 Probe 根本沒打到字的時候
 * 也是綠的。
 *
 * ⚠️ react-dom/server 不跑 effect，而 react-hook-form 的 `_state.mount` 是在 effect
 *    裡被設成 true 的（沒 mount 的 getValues() 回 defaultValues 而不是現值）。所以
 *    下面手動把它切成 mounted 來模擬「元件已經掛上去了」，而且**先驗證這個模擬是有
 *    效的**（切之前讀不到、切之後讀得到），免得整段其實是在驗一個假的東西。
 */
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const rhf = await import("react-hook-form");

const TYPED = "打進區塊的字";
const OUTER_TITLE = "活動的標題";

let probeCtx = null;
let probeField = null;
let outerForm = null;
let innerForm = null;

function Probe() {
  // LocalizedField 就是這樣拿 control 的：useFormContext()，不收 control 當 prop。
  probeCtx = rhf.useFormContext();
  probeField = rhf.useController({ control: probeCtx.control, name: "title.zh" }).field;
  return h("input", { readOnly: true, value: probeField.value ?? "" });
}

function Tree({ nest }) {
  outerForm = rhf.useForm({ defaultValues: { title: { zh: OUTER_TITLE }, slug: "an-event" } });
  innerForm = rhf.useForm({ defaultValues: { title: { zh: "" }, body: { zh: "" } } });
  const probe = h(Probe, null);
  // 產線上這一層是 <Form {...blockForm}>，而 src/components/ui/form.tsx 的
  // `const Form = FormProvider` —— 同一個東西。
  return h(rhf.FormProvider, outerForm, nest ? h(rhf.FormProvider, innerForm, probe) : probe);
}

function runTyping(nest) {
  renderToStaticMarkup(h(Tree, { nest }));
  const mountable = Boolean(outerForm.control?._state && innerForm.control?._state);
  const beforeMount = JSON.stringify(outerForm.getValues());
  outerForm.control._state.mount = true;
  innerForm.control._state.mount = true;
  probeField.onChange(TYPED); // ← 使用者打字時跑的就是這一行
  return {
    mountable,
    beforeMount,
    outer: outerForm.getValues(),
    inner: innerForm.getValues(),
  };
}

const nested = runTyping(true);
checkTrue(
  "先確認這個模擬是有效的（兩個表單都切得到 mounted 狀態）",
  nested.mountable,
  "react-hook-form 的 control._state 不見了 —— 下面整段都會變成在驗一個假的東西",
);
check("🔴 有內層 FormProvider 時，打的字進的是**區塊**表單", nested.inner.title.zh, TYPED);
check(
  "🔴 而主表單的 getValues() **完全沒有**區塊的字（驗收條件本人）",
  JSON.stringify(nested.outer).includes(TYPED),
  false,
);
check("主表單的值一個字都沒被動到", nested.outer, { title: { zh: OUTER_TITLE }, slug: "an-event" });

// ── 突變：把內層 provider 拿掉 ──────────────────────────────────────────────
const flat = runTyping(false);
check(
  "🔴【突變】拿掉內層 FormProvider → 同樣的打字寫進了**主表單**（證明上面那條有牙齒）",
  JSON.stringify(flat.outer).includes(TYPED),
  true,
);
check("【突變】而且它蓋掉的正是活動標題", flat.outer.title.zh, TYPED);
check("【突變】區塊表單則完全沒收到", flat.inner.title.zh, "");

// =============================================================================
// [3] 產線元件真的長那個形狀（AST，掃全 src/）
// =============================================================================
console.log("\n[3] 產線元件的形狀");

const editorRel = relative(ROOT, EDITOR_PATH);
const editorSrc = readFile(EDITOR_PATH);
const editorAst = parseTsx(editorSrc, editorRel);

/** 這個檔案裡 `const X = useForm(...)` 的那些 X。 */
const useFormVars = [];
walkAst(editorAst.program, (n) => {
  if (n.type !== "VariableDeclarator" || n.id?.type !== "Identifier") return;
  if (n.init?.type === "CallExpression" && n.init.callee?.type === "Identifier") {
    if (n.init.callee.name === "useForm") useFormVars.push(n.id.name);
  }
});
check("🔴 區塊編輯器自己開了剛好一個 useForm（那就是內層那一份）", useFormVars.length, 1);

/** `<Form {...X}>` 元素。 */
const formProviders = [];
walkAst(editorAst.program, (n) => {
  if (n.type === "JSXElement" && jsxName(n) === "Form") formProviders.push(n);
});
check("🔴 而且真的有一個 <Form>（＝FormProvider）把它擴散出去", formProviders.length, 1);
check(
  "🔴 <Form> 擴散的就是那個 useForm 的結果（不是主表單、不是別的東西）",
  formProviders.flatMap(jsxSpreadNames),
  useFormVars,
);

/* 每一個 LocalizedField 都要在那個 <Form> 底下。
   ⚠️ 先數 LocalizedField 有幾個：一條「都在 Form 底下」的斷言，在檔案裡一個
      LocalizedField 都沒有的時候也是綠的 —— 那種綠燈什麼都沒有在守。 */
const allLocalized = [];
walkAst(editorAst.program, (n) => {
  if (n.type === "JSXElement" && jsxName(n) === "LocalizedField") allLocalized.push(n);
});
const insideProvider = new Set();
for (const f of formProviders) {
  walkAst(f.children, (m) => {
    if (m.type === "JSXElement" && jsxName(m) === "LocalizedField") insideProvider.add(m.start);
  });
}
checkTrue(
  "（對照組）區塊編輯器上真的有 LocalizedField（否則下一條是空的）",
  allLocalized.length === 2,
  `實得 ${allLocalized.length} 個`,
);
check(
  "🔴 每一個 LocalizedField 都在內層 <Form> 底下（在外面就會綁到主表單的 control）",
  allLocalized.filter((n) => !insideProvider.has(n.start)).map((n) => n.loc?.start?.line ?? 0),
  [],
);

/* 內層的 <form> 是主表單那個隱藏 <form> 的**兄弟**，不是子孫（HTML 不能巢狀 form）。
   組裝器那一側已經驗過「主表單的 <form> 是空的」，這裡驗的是這一側：區塊的 <form>
   有自己的 onSubmit，而且它不在任何別的 <form> 裡面。 */
const editorForms = [];
walkAst(editorAst.program, (n) => {
  if (n.type === "JSXElement" && jsxName(n) === "form") editorForms.push(n);
});
check("區塊編輯器有自己的 <form>", editorForms.length, 1);
checkTrue("它有自己的 onSubmit", jsxAttr(editorForms[0], "onSubmit") !== null);
const nestedForms = [];
for (const f of editorForms) {
  walkAst(f.children, (m) => {
    if (m.type === "JSXElement" && jsxName(m) === "form") nestedForms.push(m.loc?.start?.line ?? 0);
  });
}
check("🔴 沒有 <form> 包在 <form> 裡（瀏覽器會安靜地丟掉內層那一個）", nestedForms, []);

/* handleSubmit 的第二個參數 —— 與組裝器主表單同一條規則（那邊的「雷 3」）。
   少了它，驗證失敗時按下去什麼都不會發生，而紅字可能在摺疊起來的英日文欄位裡。 */
const editorHandleSubmit = [];
walkAst(editorAst.program, (n) => {
  if (
    n.type === "CallExpression" &&
    n.callee?.type === "MemberExpression" &&
    n.callee.property?.name === "handleSubmit"
  ) {
    editorHandleSubmit.push(n.arguments.length);
  }
});
check(
  "🔴 區塊編輯器的 handleSubmit 也傳了兩個參數（onValid + onInvalid）",
  editorHandleSubmit,
  [2],
);

// =============================================================================
// [4] 🔴 排序唯一的家是那支 RPC
// =============================================================================
console.log("\n[4] 排序");

/* 兩層掃法：
     (a) **全 src/** —— admin_reorder_event_blocks 這支 RPC 被呼叫幾次（剛好一次）。
         這一條不能只掃 repo 那一個檔：重點正是「別的地方沒有第二次呼叫」。
     (b) **碰得到 event_blocks 的那一個檔**（上面用 .from("event_blocks") 找出來的，
         不是寫死的路徑）—— 裡面有沒有 .update({… sort_order …})，一個都不准有。
         那就是「client 驅動的多步驟重排」的樣子：它會撞 unique(event_id, kind,
         sort_order)，而繞過那個約束的唯一辦法（停到負數再寫）必須在同一個交易裡，
         也就是必須在 SQL 那一側。
   ⚠️ (b) 刻意只看 event_blocks 那一個檔：別的表（contact_phones、publications…）
      本來就有自己的排序寫法，把它們一起判死是一條會誤傷的斷言，而誤傷的斷言最後
      一定會被人放寬 —— 那才是真正失去覆蓋的時候。 */
let reorderRpcCalls = 0;
for (const abs of SRC_FILES) {
  const rel = relative(ROOT, abs);
  const ast = parseTsx(readFileSync(abs, "utf8"), rel);
  walkAst(ast.program, (n) => {
    if (n.type !== "CallExpression" || n.callee?.type !== "MemberExpression") return;
    if (n.callee.property?.name !== "rpc") return;
    const a0 = n.arguments[0];
    if (a0?.type === "StringLiteral" && a0.value === "admin_reorder_event_blocks") {
      reorderRpcCalls += 1;
    }
  });
}
check("🔴 admin_reorder_event_blocks 被呼叫的地方，全 src/ 剛好一處", reorderRpcCalls, 1);

const repoRel = relative(ROOT, REPO_PATH);
const repoSrc = readFile(REPO_PATH);
const repoAst = parseTsx(repoSrc, repoRel);
const updateWithSortOrder = [];
let repoUpdateCalls = 0;
let insertWithSortOrder = 0;
walkAst(repoAst.program, (n) => {
  if (n.type !== "CallExpression" || n.callee?.type !== "MemberExpression") return;
  const method = n.callee.property?.name;
  const a0 = n.arguments[0];
  if (a0?.type !== "ObjectExpression") return;
  const keys = a0.properties.map((p) => p.key?.name).filter(Boolean);
  if (method === "update") {
    repoUpdateCalls += 1;
    if (keys.includes("sort_order")) updateWithSortOrder.push(n.loc?.start?.line ?? 0);
  }
  if (method === "insert" && keys.includes("kind") && keys.includes("sort_order")) {
    insertWithSortOrder += 1;
  }
});
checkTrue(
  `（對照組）${repoRel} 裡真的有 .update({…})（否則下一條是空的）`,
  repoUpdateCalls === 1,
  `實得 ${repoUpdateCalls} 處`,
);
check(
  "🔴 event_blocks 沒有任何一處 .update({… sort_order …})（那就是 client 驅動重排的樣子）",
  updateWithSortOrder,
  [],
);
check("新增一列時才寫 sort_order（append 到 max+1，那不是重排）", insertWithSortOrder, 1);

/* 送去 RPC 的必須是**整組的完整 id 順序**。只送被交換的那兩列，漏掉的列會留在舊
   位置上，於是那一組同時存在新舊兩種編號。 */
checkTrue(
  "🔴 上移／下移送的是整組完整順序（next.map(...id)），不是被動到的那兩列",
  /ids:\s*next\.map\(\(r\)\s*=>\s*r\.id\)/.test(editorSrc),
);

/* 刪一列之後要補號，補號那一步也走同一支 RPC。 */
const removeSrc = repoSrc;
const removeFn = removeSrc.slice(
  removeSrc.indexOf("export async function removeEventBlock"),
  removeSrc.indexOf("export async function reorderEventBlocks"),
);
checkTrue("切得出 removeEventBlock()", removeFn.length > 0);
checkTrue(
  "🔴 刪掉一列之後會補號（呼叫 reorderEventBlocks）",
  removeFn.includes("reorderEventBlocks("),
);
checkFalse(
  "🔴 補號那一步沒有自己 update sort_order（走 RPC，一個交易）",
  /\.update\(/.test(removeFn),
);
/* 補號用的 id 順序要來自「照 sort_order 排好的」查詢 —— 順序錯了，補號就是打亂順序。 */
checkTrue(
  "listEventBlocks 依 sort_order 遞增排（補號送進去的順序就是它）",
  /\.order\("sort_order",\s*\{\s*ascending:\s*true\s*\}\)/.test(removeSrc),
);

// =============================================================================
// [5] 主儲存不可以把區塊正在打的字弄不見
// =============================================================================
console.log("\n[5] 區塊編輯器活得過主儲存");

/* 組裝器主儲存之後會 router.invalidate() → rows 這個 prop 換一份新的。區塊編輯器的
   useForm 必須活過那一次（使用者可能在 §9 打到一半，而他按的是 §1 的儲存）。
   兩個會弄不見它的寫法：
     (a) 編輯器裡有 useEffect 依 rows 去 reset；
     (b) 組裝器給編輯器一個會隨資料變動的 key（那就是 remount）。 */
let effectCount = 0;
const effectsDependingOnRows = [];
walkAst(editorAst.program, (n) => {
  if (n.type !== "CallExpression" || n.callee?.type !== "Identifier") return;
  if (n.callee.name !== "useEffect") return;
  effectCount += 1;
  const deps = n.arguments[1];
  if (deps?.type !== "ArrayExpression") return;
  if (deps.elements.some((e) => e?.type === "Identifier" && e.name === "rows")) {
    effectsDependingOnRows.push(n.loc?.start?.line ?? 0);
  }
});
checkTrue(
  "（對照組）編輯器裡真的有 useEffect（否則下一條是空的）",
  effectCount >= 2,
  `實得 ${effectCount}`,
);
check(
  "🔴 沒有任何 useEffect 依 rows 去 reset 表單（主儲存會換掉 rows）",
  effectsDependingOnRows,
  [],
);

const ASSEMBLER_PATH = "src/routes/admin/_shell.events.$id.tsx";
const assemblerSrc = readFile(ASSEMBLER_PATH);
const assemblerAst = parseTsx(assemblerSrc, ASSEMBLER_PATH);

const editorUses = [];
walkAst(assemblerAst.program, (n) => {
  if (n.type === "JSXElement" && jsxName(n) === "EventBlockEditor") editorUses.push(n);
});
check("組裝器上掛了三個區塊編輯器", editorUses.length, 3);
check(
  "🔴 組裝器沒有給編輯器任何 key（給了就是每次主儲存都 remount 一次）",
  editorUses.filter((n) => jsxAttr(n, "key") !== null).map((n) => n.loc?.start?.line ?? 0),
  [],
);
// 檔頭雷 1 在這一期才真的被考驗：整頁仍然不准有 formKey。
const assemblerIdents = new Set();
walkAst(assemblerAst.program, (n) => {
  if (n.type === "Identifier" || n.type === "JSXIdentifier") assemblerIdents.add(n.name);
});
checkFalse(
  "🔴 組裝器仍然沒有 formKey / setFormKey",
  assemblerIdents.has("formKey") || assemblerIdents.has("setFormKey"),
);

/* 列表那一層的 key 只能是 row.id。摻進 updated_at 之類會隨儲存改變的東西，等於每次
   存完都 remount 那一列。 */
const listKeys = [];
walkAst(editorAst.program, (n) => {
  if (n.type !== "JSXElement" || jsxName(n) !== "li") return;
  const a = jsxAttr(n, "key");
  const e = a?.value?.type === "JSXExpressionContainer" ? a.value.expression : null;
  listKeys.push(
    e?.type === "MemberExpression" && e.object?.name === "row"
      ? e.property?.name
      : "（不是 row.x）",
  );
});
check("🔴 每一列的 key 就是 row.id", listKeys, ["id"]);

// =============================================================================
// [6] 髒狀態：三段各自報，沒有髒東西時一個字都不出現
// =============================================================================
console.log("\n[6] sticky bar 講得出是哪一段");

/* 組裝器的登記簿 key 與名字都要從產線那兩份（EVENT_BLOCK_KINDS / EVENT_BLOCK_COPY）
   長出來，不是在路由檔裡再抄一份三個名字。 */
checkTrue(
  "🔴 三段的登記簿 key 由 EVENT_BLOCK_KINDS 產生（不是手打三個字串）",
  /EVENT_BLOCK_KINDS\.map\(\(k\)\s*=>\s*\[blockSectionKey\(k\),\s*EVENT_BLOCK_COPY\[k\]\.sectionTitle\]\)/.test(
    assemblerSrc,
  ),
);
check(
  "🔴 三個區塊編輯器各拿到自己那一份 onDirtyChange",
  editorUses
    .map((n) => {
      const a = jsxAttr(n, "onDirtyChange");
      const e = a?.value?.type === "JSXExpressionContainer" ? a.value.expression : null;
      return e?.type === "MemberExpression" && e.object?.name === "handleBlockDirty"
        ? e.property?.name
        : null;
    })
    .sort(),
  [...EVENT_BLOCK_KINDS].sort(),
);

/* 行為：拿**產線的**登記簿函式與**產線的**段落名字跑一遍。 */
const blockKeys = EVENT_BLOCK_KINDS.map((k) => `block:${k}`);
const labelOf = (key) => {
  const kind = key.startsWith("block:") ? key.slice("block:".length) : null;
  return kind ? EVENT_BLOCK_COPY[kind].sectionTitle : "活動內容";
};

let registry = {};
check(
  "🔴 什麼都沒改時，sticky bar 上一個字都不出現",
  dirtyBannerText(dirtyKeys(registry).map(labelOf)),
  null,
);

registry = markDirty(registry, blockKeys[0], true);
const oneDirty = dirtyBannerText(dirtyKeys(registry).map(labelOf));
checkTrue("一段髒時有話說", typeof oneDirty === "string" && oneDirty.length > 0);
checkTrue(
  "🔴 而且點名是哪一段（用的是文案表裡那個名字）",
  oneDirty.includes(EVENT_BLOCK_COPY[EVENT_BLOCK_KINDS[0]].sectionTitle),
  oneDirty,
);

registry = markDirty(registry, "content", true);
const twoDirty = dirtyBannerText(dirtyKeys(registry).map(labelOf));
checkTrue(
  "兩段髒時兩段都點到名",
  twoDirty.includes(EVENT_BLOCK_COPY[EVENT_BLOCK_KINDS[0]].sectionTitle) &&
    twoDirty.includes("活動內容"),
  twoDirty,
);

/* 🔴 存完就要安靜下來。這一條在守的是「常駐一句『記得儲存』」那個反例 —— 那種提示
   人在第三天就停止閱讀，於是真的有東西沒存的那一次也一起被跳過。 */
for (const k of [...blockKeys, "content"]) registry = markDirty(registry, k, false);
check("🔴 全部存完之後又回到一個字都沒有", dirtyBannerText(dirtyKeys(registry).map(labelOf)), null);

// 編輯器卸載時要把自己從登記簿上撤掉，否則那一句話會一直掛著。
checkTrue(
  "🔴 編輯器卸載時把自己標成不髒（否則 sticky bar 會一直說有一段沒存）",
  /return\s*\(\)\s*=>\s*onDirtyChange\(false\)/.test(editorSrc),
);

/* ── 同一份登記簿也要餵到「離開這一頁」的守衛 ───────────────────────────────
   D3 那一期只有主表單會髒，所以離開守衛只被主表單考驗過。D4 之後「在區塊裡打了字
   沒存就點側欄」是一條真的會走到的路 —— 而它必須跳確認。

   ⚠️ 這一條在守的是**同一份 state**：sticky bar 那句話與離開守衛如果各自看一份，
      早晚會分岔成「畫面說有東西沒存，但點側欄直接就走了」。 */
checkTrue(
  "🔴 離開守衛看的就是那一份登記簿（pageDirty = hasDirty(dirty)）",
  /const pageDirty = hasDirty\(dirty\);/.test(assemblerSrc),
);
checkTrue(
  "🔴 而 sticky bar 那句話也是同一份 dirty 算出來的",
  /const bannerText = dirtyBannerText\(dirtyKeys\(dirty\)\./.test(assemblerSrc),
);
checkTrue(
  "🔴 守衛是「髒就擋」（除了存完自己導頁那一次的放行 ref）",
  /shouldBlockLeaving = \(\) => pageDirty && !bypassLeaveGuard\.current/.test(assemblerSrc),
);
// 行為：只有區塊髒、主表單乾淨時，守衛照樣要擋。
const onlyBlockDirty = markDirty({}, blockKeys[1], true);
check("🔴 只有區塊髒（主表單乾淨）時，離開守衛還是會擋", hasDirty(onlyBlockDirty), true);
check(
  "🔴 那一段存完之後就不擋了（存完離開不該再跳確認）",
  hasDirty(markDirty(onlyBlockDirty, blockKeys[1], false)),
  false,
);
check("什麼都沒改時本來就不擋", hasDirty({}), false);

// =============================================================================
// [7] schema：kind 的名單只有一份、sort_order 不在表單上
// =============================================================================
console.log("\n[7] eventBlockSchema");

const validBlock = {
  event_id: "e1",
  kind: "agenda",
  title: { zh: "19:30", en: "19:30", ja: "19:30" },
  body: { zh: "入場", en: "Doors", ja: "開場" },
};
check("三語齊備的一列過得了", eventBlockSchema.safeParse(validBlock).success, true);
for (const kind of EVENT_BLOCK_KINDS) {
  check(`kind='${kind}' 過得了`, eventBlockSchema.safeParse({ ...validBlock, kind }).success, true);
}
for (const bad of ["pricing", "feature", "", "Agenda"]) {
  check(
    `🔴 kind='${bad}' 擋下來（0027 的 CHECK 只認三種）`,
    eventBlockSchema.safeParse({ ...validBlock, kind: bad }).success,
    false,
  );
}
check(
  "🔴 英日文缺一個就擋下來（0027 兩欄都 not null，而空字串過得了 CHECK）",
  eventBlockSchema.safeParse({ ...validBlock, title: { zh: "19:30", en: "", ja: "19:30" } })
    .success,
  false,
);
const shapeKeys = Object.keys(eventBlockSchema.shape).sort();
check("schema 上就是這五個 key", shapeKeys, ["body", "event_id", "id", "kind", "title"]);
checkFalse(
  "🔴 sort_order 不在 schema 上（排序的唯一入口是那支 RPC，不是編輯這一列的路）",
  shapeKeys.includes("sort_order"),
);

// =============================================================================
// [8] §3 是唯讀鏡子：一條寫回場次的路都沒有
// =============================================================================
console.log("\n[8] §3 場次");

/* seats_taken 只由 0020 §7 的三支 RPC 在持有列鎖時維護。從組裝器寫回一個幾分鐘前
   讀到的計數器就是超賣，所以這兩個檔案裡不准有任何 event_sessions 的寫入路徑。 */
for (const [label, src] of [
  ["組裝器", assemblerSrc],
  ["區塊編輯器", editorSrc],
]) {
  checkFalse(`🔴 ${label}裡沒有 from("event_sessions")`, /from\("event_sessions"\)/.test(src));
  checkFalse(
    `🔴 ${label}裡沒有任何場次的寫入 fn（upsert／remove／update session）`,
    /(upsert|update|remove|delete)EventSession/i.test(src),
  );
}
// 對照組：組裝器**讀**得到場次（否則上面兩條在 §3 是一塊空白時也是綠的）。
checkTrue("（對照組）組裝器真的讀場次", /listSessionsForEvent/.test(assemblerSrc));
checkTrue("（對照組）而且真的把 seats_taken 印出來", /seats_taken/.test(assemblerSrc));
checkTrue(
  "🔴 §3 指得出去哪裡改（MirrorNote 連到 /admin/registrations）",
  /to="\/admin\/registrations"/.test(assemblerSrc),
);
checkTrue(
  "🔴 而且畫面上講出「名額改不動」的理由，不是只寫在註解裡",
  /名額（seats_taken）由報名流程在資料庫裡維護，這一頁\*\*改不動\*\*/.test(assemblerSrc) ||
    /seats_taken[^"]*改不動/.test(assemblerSrc),
);

// =============================================================================
// [連線] 真的 DB：重排不換 id、刪掉中間那一列不留洞
// =============================================================================
console.log("\n[連線] 真的跑一次（BEGIN … ROLLBACK）");

/**
 * 一個**開著不關**的 psql 連線。
 *
 * 🔴 為什麼不是「每次 execFile 一個 psql」：這一段要驗的東西橫跨好幾個來回
 *    （建資料 → 重排 → 刪掉中間那一列 → **由 JS 決定要送哪幾個 id** → 補號 → 讀回來），
 *    而中間那個「由 JS 決定」正是產線 removeEventBlock() 做的事，不可以搬到 SQL 裡去
 *    做掉 —— 那就變成「測試自己先把要驗的東西算好了再驗」。
 *
 *    換一個 psql 行程就換一個 session，而 `begin` 的內容會跟著行程結束被 rollback，
 *    identity 的序號卻**不會**倒回去（序號本來就不受交易保護）。第一次跑拿到的 id
 *    在第二個行程裡根本不存在，於是補號變成一次安靜的 no-op —— 那正是這一版第一次
 *    跑出來的假結果（補號後讀到 1,3，因為 RPC 收到的是上一輪的 id）。
 *
 * 整段開頭 `begin`、結尾 `rollback`，所以這個庫一個字都不會變。
 */
function openPsql(url) {
  const child = spawn("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", url], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let waiter = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    out += d;
    if (waiter && out.includes(waiter.mark)) {
      const idx = out.indexOf(waiter.mark);
      const chunk = out.slice(0, idx);
      out = out.slice(idx + waiter.mark.length);
      const w = waiter;
      waiter = null;
      w.resolve(chunk);
    }
  });
  child.stderr.on("data", (d) => {
    err += d;
  });
  child.on("exit", (code) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(new Error(`psql 提前結束（code=${code}）：${err.slice(-800)}`));
    }
  });

  let seq = 0;
  return {
    /** 送一段 SQL 進去，回它印出來的東西（不含結束標記）。 */
    run(sql) {
      seq += 1;
      const mark = `<<<D4-${seq}>>>`;
      return new Promise((resolve, reject) => {
        waiter = { mark, resolve, reject };
        child.stdin.write(`${sql}\n\\echo ${mark}\n`);
        setTimeout(() => {
          if (waiter?.mark === mark) {
            waiter = null;
            reject(new Error(`psql 逾時。stderr：${err.slice(-800)}`));
          }
        }, 20000).unref();
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

/** `key|value` 的輸出 → 物件。 */
function kv(stdout) {
  return Object.fromEntries(
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("|"))
      .map((l) => [l.slice(0, l.indexOf("|")), l.slice(l.indexOf("|") + 1)]),
  );
}

if (!PG_URL) {
  skipped.push("[連線] 沒有設 EVENT_BLOCK_EDITOR_SELFTEST_PG_URL，整段跳過");
  console.log(yellow("  ⚠ 跳過：沒有 EVENT_BLOCK_EDITOR_SELFTEST_PG_URL"));
  console.log(yellow("     設好之後重跑，才會驗到「重排之後 id 一個都沒變」與"));
  console.log(yellow("     「刪掉中間那一列之後 sort_order 是 1,2 沒有洞」。指令見檔頭。"));
} else {
  const db = openPsql(PG_URL);
  try {
    /**
     * 🔴 **不建表、不套 migration。** 這個庫必須已經套過 0027 —— 讓測試自己先把要驗的
     *    東西建好，等於從 migration 裡刪光它也照樣綠（這個 repo 出過那種假陽性）。
     */
    const pre = kv(
      await db.run(
        `select 'tbl|' || (to_regclass('public.event_blocks') is not null)::text
   union all select 'fn|' || (to_regprocedure('public.admin_reorder_event_blocks(text,text,bigint[])') is not null)::text;`,
      ),
    );
    checkTrue(
      "這個庫已經套過 0027：public.event_blocks 在",
      pre.tbl === "true",
      JSON.stringify(pre),
    );
    checkTrue("admin_reorder_event_blocks() 在", pre.fn === "true");

    if (pre.tbl !== "true" || pre.fn !== "true") {
      fail += 1;
      console.log(red("  ✗ 這個庫沒套過 0027 —— 行為探針不跑（這一支不會幫你套）"));
    } else {
      // ── 建資料。整段包在一個交易裡，最後 rollback。 ──────────────────────
      const seeded = kv(
        await db.run(`
begin;
insert into public.event_categories (id, label, sort_order)
  values ('d4-cat', '{"zh":"自檢","en":"selftest","ja":"セルフテスト"}'::jsonb, 999);
insert into public.events (id, slug, title, summary, description, display_date, category,
                           external_url, registration_type, payment_enabled, is_published, sort_order)
  values ('d4-ev', 'd4-ev',
    '{"zh":"自檢","en":"s","ja":"s"}'::jsonb, '{"zh":"自檢","en":"s","ja":"s"}'::jsonb,
    '{"zh":"自檢","en":"s","ja":"s"}'::jsonb, '2026.01.01', 'd4-cat', 'https://example.com/e',
    'external', false, false, 0);
insert into public.event_blocks (event_id, kind, title, body, sort_order) values
  ('d4-ev','agenda','{"zh":"19:30","en":"19:30","ja":"19:30"}'::jsonb,'{"zh":"入場","en":"Doors","ja":"開場"}'::jsonb,1),
  ('d4-ev','agenda','{"zh":"19:40","en":"19:40","ja":"19:40"}'::jsonb,'{"zh":"開場","en":"Start","ja":"開始"}'::jsonb,2),
  ('d4-ev','agenda','{"zh":"21:00","en":"21:00","ja":"21:00"}'::jsonb,'{"zh":"散場","en":"End","ja":"終了"}'::jsonb,3);
select 'before|' || string_agg(id::text || ':' || sort_order::text, ',' order by sort_order)
  from public.event_blocks where event_id='d4-ev' and kind='agenda';`),
      );
      const before = (seeded.before ?? "").split(",");
      const beforeIds = before.map((p) => p.split(":")[0]);
      console.log(`      重排前：${seeded.before}`);
      check(
        "重排前有三列，sort_order 是 1,2,3",
        before.map((p) => p.split(":")[1]),
        ["1", "2", "3"],
      );

      // ── (1) 重排：[1,2,3] → [3,2,1]。id 一個都不准變。 ────────────────────
      //    送進 RPC 的順序由**這一側**算（把 beforeIds 倒過來），不是叫 SQL 自己
      //    order by ... desc —— 後者等於讓待測的那一支自己決定答案。
      const reversed = [...beforeIds].reverse();
      const reordered = kv(
        await db.run(`
do $$ begin perform public.admin_reorder_event_blocks('d4-ev','agenda', array[${reversed.join(",")}]::bigint[]); end $$;
select 'afterReorder|' || string_agg(id::text || ':' || sort_order::text, ',' order by sort_order)
  from public.event_blocks where event_id='d4-ev' and kind='agenda';`),
      );
      const afterReorder = (reordered.afterReorder ?? "").split(",");
      const afterIds = afterReorder.map((p) => p.split(":")[0]);
      console.log(`      重排後：${reordered.afterReorder}`);
      check(
        "🔴 [1,2,3] → [3,2,1] 之後 id 一個都沒變（是換順序，不是刪掉重建）",
        [...afterIds].sort(),
        [...beforeIds].sort(),
      );
      check("🔴 而且順序真的照送進去的那一份倒過來了", afterIds, reversed);
      check(
        "重排後 sort_order 還是 1,2,3（沒有任何一列留在負數停車位）",
        afterReorder.map((p) => p.split(":")[1]),
        ["1", "2", "3"],
      );

      /* ── (2) 刪掉中間那一列，**先不補號** ────────────────────────────────
         這一步量的是「洞」。它是下一條的**負控制組**：沒有它，「補號之後是 1,2」
         有可能只是因為資料庫自己就長那樣，而不是因為補號那一步真的做了事。 */
      const middleId = afterIds[1];
      const deleted = kv(
        await db.run(`
delete from public.event_blocks where id = ${middleId};
select 'afterDelete|' || string_agg(id::text || ':' || sort_order::text, ',' order by sort_order)
  from public.event_blocks where event_id='d4-ev' and kind='agenda';
select 'remaining|' || string_agg(id::text, ',' order by sort_order)
  from public.event_blocks where event_id='d4-ev' and kind='agenda';`),
      );
      const afterDelete = (deleted.afterDelete ?? "").split(",");
      console.log(`      刪掉中間那一列（還沒補號）：${deleted.afterDelete}`);
      check(
        "🔴【負控制】只 DELETE 不補號 → sort_order 是 1,3（有一個洞）",
        afterDelete.map((p) => p.split(":")[1]),
        ["1", "3"],
      );

      /* ── (3) 補號 ──────────────────────────────────────────────────────
         這裡送進 RPC 的 id 清單由**這一側**算出來，形狀與產線
         removeEventBlock() 第二步一模一樣：listEventBlocks()（order by sort_order
         asc）→ filter(kind) → map(id)。[4] 那一段用 AST 驗過產線真的是這樣取的。 */
      const remainingIds = (deleted.remaining ?? "").split(",").filter(Boolean);
      check("剩下兩列", remainingIds.length, 2);
      const renumberedOut = kv(
        await db.run(`
do $$ begin perform public.admin_reorder_event_blocks('d4-ev','agenda', array[${remainingIds.join(",")}]::bigint[]); end $$;
select 'renumbered|' || string_agg(id::text || ':' || sort_order::text, ',' order by sort_order)
  from public.event_blocks where event_id='d4-ev' and kind='agenda';`),
      );
      const renumbered = (renumberedOut.renumbered ?? "").split(",");
      console.log(`      補號之後：${renumberedOut.renumbered}`);
      check(
        "🔴 補號之後 sort_order 是 1,2 —— 沒有洞（驗收條件本人）",
        renumbered.map((p) => p.split(":")[1]),
        ["1", "2"],
      );
      check(
        "🔴 而且補號也沒有換掉任何 id（剩下的還是原本那兩列）",
        renumbered.map((p) => p.split(":")[0]),
        remainingIds,
      );
      check(
        "被刪掉的就是中間那一列，不是別的",
        renumbered.map((p) => p.split(":")[0]).includes(middleId),
        false,
      );

      // 整段收回去，這個庫一個字都沒變。
      const left = kv(
        await db.run(
          `rollback;\nselect 'left|' || count(*)::text from public.event_blocks where event_id='d4-ev';`,
        ),
      );
      check("🔴 rollback 之後這個庫一列都沒留下（全程沒有動到既有資料）", left.left, "0");
    }
  } catch (err) {
    fail += 1;
    console.log(red("  ✗ [連線] 跑不起來"));
    console.log(red(`      ${String(err.stderr ?? err.message ?? err).slice(0, 900)}`));
  } finally {
    db.close();
  }
}

// -----------------------------------------------------------------------------
console.log("\n────────────────────────────────────────────────────");
for (const s of skipped) console.log(yellow(`⚠ ${s}`));
console.log(`${pass} passed, ${fail} failed`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
