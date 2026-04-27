#!/usr/bin/env bun
/**
 * Static meta-tag audit for ZH / EN / JA — no browser required.
 *
 * Parses every src/routes/*.tsx file, finds the useDocumentMeta({...}) call,
 * and asserts:
 *   - title and description are objects with non-empty zh / en / ja
 *   - each language string passes a script heuristic (CJK for zh/ja, latin for en)
 *   - if ogTitle / ogDescription are provided they have all 3 langs too
 *
 * Then loads src/i18n/strings.ts content data and verifies every Localized
 * field across events, exhibitions, news, journeys, curated, collaborations
 * has all three languages populated, so language switching never falls back
 * silently to zh.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = _traverse.default ?? _traverse;

const ROUTES_DIR = "src/routes";
const LANGS = ["zh", "en", "ja"];
const PATTERNS = {
  zh: /[\u4e00-\u9fff]/,
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  en: /[A-Za-z]/,
};

const failures = [];
const fail = (file, msg) => failures.push(`${file}: ${msg}`);

function getStringValue(node) {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis.map((q) => q.value.cooked).join("");
  return null;
}

function checkLocalizedObject(file, label, objNode) {
  if (!objNode || objNode.type !== "ObjectExpression") {
    fail(file, `${label}: not an object literal (cannot statically verify)`);
    return;
  }
  const found = {};
  for (const prop of objNode.properties) {
    if (prop.type !== "ObjectProperty") continue;
    const key = prop.key.name ?? prop.key.value;
    if (!LANGS.includes(key)) continue;
    const val = getStringValue(prop.value);
    if (val === null) {
      fail(file, `${label}.${key}: not a static string`);
      continue;
    }
    if (!val.trim()) fail(file, `${label}.${key}: empty`);
    if (!PATTERNS[key].test(val)) fail(file, `${label}.${key}: not in ${key} → "${val.slice(0, 50)}"`);
    found[key] = val;
  }
  for (const l of LANGS) if (!(l in found)) fail(file, `${label}: missing ${l}`);
}

async function auditRoute(file) {
  const src = await readFile(file, "utf8");
  if (!src.includes("useDocumentMeta")) {
    fail(file, "no useDocumentMeta() call");
    return;
  }
  const ast = parse(src, { sourceType: "module", plugins: ["typescript", "jsx"] });

  // Resolve identifier references (e.g. `description: PAGE.intro`) to their literal objects
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
    return null;
  }

  let called = false;
  traverse(ast, {
    CallExpression(path) {
      if (path.node.callee.type !== "Identifier" || path.node.callee.name !== "useDocumentMeta") return;
      called = true;
      const arg = path.node.arguments[0];
      if (!arg || arg.type !== "ObjectExpression") {
        fail(file, "useDocumentMeta argument is not an object literal");
        return;
      }
      const required = ["title", "description"];
      const optional = ["ogTitle", "ogDescription"];
      for (const key of [...required, ...optional]) {
        const prop = arg.properties.find(
          (p) => p.type === "ObjectProperty" && (p.key.name ?? p.key.value) === key,
        );
        if (!prop) {
          if (required.includes(key)) fail(file, `missing ${key}`);
          continue;
        }
        const obj = resolveObject(prop.value);
        if (!obj) {
          fail(file, `${key}: cannot resolve to object literal`);
          continue;
        }
        checkLocalizedObject(file, key, obj);
      }
    },
  });
  if (!called) fail(file, "useDocumentMeta not invoked in route");
}

async function auditContent() {
  const file = "src/data/content.ts";
  const src = await readFile(file, "utf8");
  const ast = parse(src, { sourceType: "module", plugins: ["typescript"] });

  // Walk every ObjectExpression; if it has any of {zh,en,ja} as keys, require all three with non-empty strings/arrays
  traverse(ast, {
    ObjectExpression(path) {
      const keys = path.node.properties
        .filter((p) => p.type === "ObjectProperty")
        .map((p) => p.key.name ?? p.key.value);
      const hasAny = LANGS.some((l) => keys.includes(l));
      if (!hasAny) return;
      for (const l of LANGS) {
        const prop = path.node.properties.find(
          (p) => p.type === "ObjectProperty" && (p.key.name ?? p.key.value) === l,
        );
        if (!prop) {
          fail(file, `${path.node.loc.start.line}: localized object missing ${l}`);
          continue;
        }
        const v = prop.value;
        if (v.type === "StringLiteral" || v.type === "TemplateLiteral") {
          const s = getStringValue(v);
          if (!s || !s.trim()) fail(file, `${path.node.loc.start.line}: ${l} is empty`);
          else if (!PATTERNS[l].test(s)) fail(file, `${path.node.loc.start.line}: ${l} not in language → "${s.slice(0, 40)}"`);
        } else if (v.type === "ArrayExpression") {
          if (v.elements.length === 0) fail(file, `${path.node.loc.start.line}: ${l} array empty`);
        }
      }
    },
  });
}

async function main() {
  const files = (await readdir(ROUTES_DIR))
    .filter((f) => f.endsWith(".tsx") && f !== "__root.tsx")
    .map((f) => join(ROUTES_DIR, f));

  console.log(`→ Auditing ${files.length} routes + content data\n`);

  for (const f of files) {
    const before = failures.length;
    await auditRoute(f);
    console.log(`  ${failures.length === before ? "✓" : "✗"} ${f}`);
  }

  console.log("\n→ Auditing src/data/content.ts");
  const before = failures.length;
  await auditContent();
  console.log(`  ${failures.length === before ? "✓" : "✗"} content.ts`);

  if (failures.length) {
    console.error(`\n✗ ${failures.length} issue(s):\n`);
    for (const f of failures) console.error(`  • ${f}`);
    process.exit(1);
  }
  console.log(`\n✓ All routes have complete zh/en/ja meta and all content fields are localized.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
