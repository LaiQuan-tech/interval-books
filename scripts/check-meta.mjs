#!/usr/bin/env bun
/**
 * Static meta-tag audit for ZH / EN / JA — no browser required.
 *
 * Parses every src/routes/*.tsx file, finds the useDocumentMeta({...}) call,
 * and asserts that title / description / ogTitle / ogDescription are localized
 * objects with non-empty, language-correct strings for zh / en / ja.
 *
 * Also walks src/data/content.ts and verifies every Localized object has all
 * three languages populated, so language switching never silently falls back.
 *
 * Outputs:
 *   - Console summary
 *   - reports/meta-audit.json — structured per-route / per-language findings
 *     for tracking and triage.
 */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = _traverse.default ?? _traverse;

const ROUTES_DIR = "src/routes";
const CONTENT_FILE = "src/data/content.ts";
const REPORT_PATH = "reports/meta-audit.json";
const LANGS = ["zh", "en", "ja"];
const PATTERNS = {
  zh: /[\u4e00-\u9fff]/,
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  en: /[A-Za-z]/,
};
const REQUIRED_FIELDS = ["title", "description"];
const OPTIONAL_FIELDS = ["ogTitle", "ogDescription"];

/** @type {Array<{file:string,route?:string,field?:string,lang?:string,severity:'error'|'warning',code:string,message:string,line?:number}>} */
const findings = [];
const record = (entry) => findings.push({ severity: "error", ...entry });

function getStringValue(node) {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis.map((q) => q.value.cooked).join("");
  return null;
}

function routeFromFile(file) {
  const base = file.replace(/^src\/routes\//, "").replace(/\.tsx$/, "");
  if (base === "index") return "/";
  return "/" + base;
}

function checkLocalizedObject(file, route, field, objNode, line) {
  if (!objNode || objNode.type !== "ObjectExpression") {
    record({
      file, route, field, line,
      code: "non_literal_object",
      message: `${field}: not an object literal — cannot statically verify`,
    });
    return;
  }
  const seen = {};
  for (const prop of objNode.properties) {
    if (prop.type !== "ObjectProperty") continue;
    const key = prop.key.name ?? prop.key.value;
    if (!LANGS.includes(key)) continue;
    const val = getStringValue(prop.value);
    if (val === null) {
      record({
        file, route, field, lang: key, line: prop.loc?.start.line,
        code: "non_static_string",
        message: `${field}.${key}: not a static string`,
      });
      continue;
    }
    if (!val.trim()) {
      record({
        file, route, field, lang: key, line: prop.loc?.start.line,
        code: "empty_string",
        message: `${field}.${key}: empty string`,
      });
    } else if (!PATTERNS[key].test(val)) {
      record({
        file, route, field, lang: key, line: prop.loc?.start.line,
        code: "wrong_language",
        message: `${field}.${key}: text does not match language → "${val.slice(0, 60)}"`,
      });
    }
    seen[key] = val;
  }
  for (const l of LANGS) {
    if (!(l in seen)) {
      record({
        file, route, field, lang: l, line,
        code: "missing_language",
        message: `${field}: missing ${l} translation`,
      });
    }
  }
}

async function auditRoute(file) {
  const route = routeFromFile(file);
  const src = await readFile(file, "utf8");
  if (!src.includes("useDocumentMeta")) {
    record({ file, route, code: "no_hook_call", message: "useDocumentMeta() not used in route" });
    return;
  }
  const ast = parse(src, { sourceType: "module", plugins: ["typescript", "jsx"] });

  const topObjects = new Map();
  traverse(ast, {
    VariableDeclarator(path) {
      if (path.node.id.type === "Identifier" && path.node.init?.type === "ObjectExpression") {
        topObjects.set(path.node.id.name, path.node.init);
      }
    },
  });

  function resolveObject(node) {
    if (!node) return null;
    if (node.type === "ObjectExpression") return node;
    if (node.type === "MemberExpression" && node.object.type === "Identifier") {
      const root = topObjects.get(node.object.name);
      if (!root) return null;
      const key = node.property.name ?? node.property.value;
      const prop = root.properties.find(
        (p) => p.type === "ObjectProperty" && (p.key.name ?? p.key.value) === key,
      );
      return prop?.value?.type === "ObjectExpression" ? prop.value : null;
    }
    if (node.type === "Identifier") return topObjects.get(node.name) ?? null;
    if (node.type === "CallExpression") {
      // Meta is now DB-driven: src/lib/cms.ts's pageText() returns accessors
      // like `p.metaTitle(fallback)` that read from Supabase at runtime and
      // fall back to the in-repo constant when the DB is empty/unreachable.
      // We can't know the DB value statically, but the fallback argument is
      // still a real object literal worth auditing for zh/en/ja completeness
      // — so unwrap the call and resolve through its argument(s) instead.
      // If a call has several arguments, use the first one that resolves to
      // an object literal. If none do (e.g. a fully dynamic expression with
      // no literal fallback), fall through to `null` so the caller still
      // reports unresolved_reference rather than silently passing.
      for (const arg of node.arguments) {
        const resolved = resolveObject(arg);
        if (resolved) return resolved;
      }
      return null;
    }
    return null;
  }

  let called = false;
  traverse(ast, {
    CallExpression(path) {
      if (path.node.callee.type !== "Identifier" || path.node.callee.name !== "useDocumentMeta") return;
      called = true;
      const arg = path.node.arguments[0];
      const callLine = path.node.loc?.start.line;
      if (!arg || arg.type !== "ObjectExpression") {
        record({ file, route, line: callLine, code: "non_object_arg", message: "useDocumentMeta argument is not an object literal" });
        return;
      }
      for (const key of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
        const prop = arg.properties.find(
          (p) => p.type === "ObjectProperty" && (p.key.name ?? p.key.value) === key,
        );
        if (!prop) {
          if (REQUIRED_FIELDS.includes(key)) {
            record({ file, route, field: key, line: callLine, code: "missing_field", message: `missing required field: ${key}` });
          }
          continue;
        }
        const obj = resolveObject(prop.value);
        if (!obj) {
          record({ file, route, field: key, line: prop.loc?.start.line, code: "unresolved_reference", message: `${key}: cannot resolve to object literal (referenced identifier not found)` });
          continue;
        }
        checkLocalizedObject(file, route, key, obj, prop.loc?.start.line);
      }
    },
  });
  if (!called) {
    record({ file, route, code: "hook_not_invoked", message: "useDocumentMeta imported but not invoked" });
  }
}

async function auditContent() {
  const file = CONTENT_FILE;
  let src;
  try { src = await readFile(file, "utf8"); }
  catch { record({ file, code: "missing_file", message: "content file not found" }); return; }
  const ast = parse(src, { sourceType: "module", plugins: ["typescript"] });

  traverse(ast, {
    ObjectExpression(path) {
      const props = path.node.properties.filter((p) => p.type === "ObjectProperty");
      const keys = props.map((p) => p.key.name ?? p.key.value);
      const hasAny = LANGS.some((l) => keys.includes(l));
      if (!hasAny) return;
      const line = path.node.loc?.start.line;
      for (const l of LANGS) {
        const prop = props.find((p) => (p.key.name ?? p.key.value) === l);
        if (!prop) {
          record({ file, lang: l, line, code: "missing_language", message: `content object @ line ${line}: missing ${l}` });
          continue;
        }
        const v = prop.value;
        if (v.type === "StringLiteral" || v.type === "TemplateLiteral") {
          const s = getStringValue(v);
          if (!s || !s.trim()) {
            record({ file, lang: l, line: prop.loc?.start.line, code: "empty_string", message: `content @ line ${line}: ${l} is empty` });
          } else if (!PATTERNS[l].test(s)) {
            record({ file, lang: l, line: prop.loc?.start.line, code: "wrong_language", message: `content @ line ${line}: ${l} text does not match language → "${s.slice(0, 50)}"` });
          }
        } else if (v.type === "ArrayExpression") {
          if (v.elements.length === 0) {
            record({ file, lang: l, line: prop.loc?.start.line, code: "empty_array", message: `content @ line ${line}: ${l} array is empty` });
          }
        }
      }
    },
  });
}

function buildReport(routeFiles) {
  const byRoute = {};
  const byLang = { zh: 0, en: 0, ja: 0, _none: 0 };
  const byCode = {};

  for (const f of routeFiles) {
    byRoute[routeFromFile(f)] = { file: f, ok: true, issues: [] };
  }
  byRoute["__content__"] = { file: CONTENT_FILE, ok: true, issues: [] };

  for (const x of findings) {
    const key = x.route ?? "__content__";
    if (!byRoute[key]) byRoute[key] = { file: x.file, ok: true, issues: [] };
    byRoute[key].ok = false;
    byRoute[key].issues.push(x);
    byLang[x.lang ?? "_none"] = (byLang[x.lang ?? "_none"] ?? 0) + 1;
    byCode[x.code] = (byCode[x.code] ?? 0) + 1;
  }

  const totalChecks = routeFiles.length * LANGS.length * (REQUIRED_FIELDS.length + OPTIONAL_FIELDS.length);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      routesAudited: routeFiles.length,
      languages: LANGS,
      totalIssues: findings.length,
      issuesByLanguage: byLang,
      issuesByCode: byCode,
      passed: findings.length === 0,
      coverage: { fields: [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS], approxChecks: totalChecks },
    },
    routes: byRoute,
    findings,
  };
}

async function main() {
  const files = (await readdir(ROUTES_DIR))
    .filter((f) => f.endsWith(".tsx") && f !== "__root.tsx")
    .map((f) => join(ROUTES_DIR, f))
    .sort();

  console.log(`→ Auditing ${files.length} routes + content data\n`);

  for (const f of files) {
    const before = findings.length;
    await auditRoute(f);
    const routeIssues = findings.length - before;
    console.log(`  ${routeIssues === 0 ? "✓" : "✗"} ${f}${routeIssues ? `  (${routeIssues} issue${routeIssues > 1 ? "s" : ""})` : ""}`);
  }

  console.log(`\n→ Auditing ${CONTENT_FILE}`);
  const before = findings.length;
  await auditContent();
  const contentIssues = findings.length - before;
  console.log(`  ${contentIssues === 0 ? "✓" : "✗"} ${CONTENT_FILE}${contentIssues ? `  (${contentIssues} issue${contentIssues > 1 ? "s" : ""})` : ""}`);

  const report = buildReport(files);
  await mkdir("reports", { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`\n→ Wrote ${relative(process.cwd(), REPORT_PATH)}`);

  if (findings.length) {
    console.error(`\n✗ ${findings.length} issue(s):`);
    for (const f of findings) {
      const loc = f.line ? `:${f.line}` : "";
      console.error(`  • [${f.code}] ${f.file}${loc}${f.lang ? ` (${f.lang})` : ""} — ${f.message}`);
    }
    process.exit(1);
  }
  console.log(`\n✓ All routes have complete zh/en/ja meta and all content fields are localized.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
