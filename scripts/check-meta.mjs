#!/usr/bin/env node
/**
 * Automated meta-tag audit for ZH / EN / JA.
 *
 * 1. Boots the dev server (or reuses one at $PREVIEW_URL).
 * 2. Loads each route in a headless browser (Playwright via Chromium).
 * 3. For each language, sets localStorage("interval-books-lang") and reloads.
 * 4. Asserts <title>, meta[name=description], og:title, og:description,
 *    twitter:title, twitter:description are present, non-empty, and language-
 *    appropriate. Verifies og:image / twitter:image do NOT leak between routes.
 *
 * Usage:
 *   bun scripts/check-meta.mjs                # auto-boots `bun run dev`
 *   PREVIEW_URL=http://localhost:5173 bun scripts/check-meta.mjs
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const ROUTES = [
  { path: "/",            expectImage: true  },
  { path: "/about",       expectImage: true  },
  { path: "/visit",       expectImage: false },
  { path: "/events",      expectImage: false },
  { path: "/exhibitions", expectImage: false },
  { path: "/journeys",    expectImage: true  },
  { path: "/curated",     expectImage: false },
  { path: "/news",        expectImage: false },
  { path: "/contact",     expectImage: false },
  { path: "/curation",    expectImage: false },
  { path: "/privacy",     expectImage: false },
];

const LANGS = ["zh", "en", "ja"];

// Minimal language heuristics — each (lang, content) pair must contain at least
// one character from this set, otherwise the tag is likely wrong-language.
const LANG_PATTERNS = {
  zh: /[\u4e00-\u9fff]/,
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/, // hiragana/katakana/kanji
  en: /[A-Za-z]/,
};

let serverProc;
async function ensureServer() {
  if (process.env.PREVIEW_URL) return process.env.PREVIEW_URL;
  serverProc = spawn("bun", ["run", "dev"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: "5173" },
  });
  let url = "";
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("dev server timeout")), 60000);
    serverProc.stdout.on("data", (b) => {
      const s = b.toString();
      const m = s.match(/https?:\/\/localhost:\d+/);
      if (m && !url) { url = m[0]; clearTimeout(t); resolve(); }
    });
    serverProc.stderr.on("data", (b) => process.stderr.write(b));
  });
  await sleep(1500);
  return url;
}

async function main() {
  const { chromium } = await import("playwright");
  const baseUrl = await ensureServer();
  console.log(`→ Auditing ${baseUrl}\n`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const failures = [];

  // Seed localStorage on first load
  await page.goto(baseUrl + "/");

  for (const lang of LANGS) {
    await page.evaluate((l) => localStorage.setItem("interval-books-lang", l), lang);

    for (const { path, expectImage } of ROUTES) {
      // Navigate fresh so we observe both SSR + post-hydration state
      await page.goto(baseUrl + path, { waitUntil: "networkidle" });
      // Wait a tick for useDocumentMeta effect to run
      await page.waitForTimeout(150);

      const meta = await page.evaluate(() => {
        const get = (sel) =>
          document.head.querySelector(sel)?.getAttribute("content") ?? null;
        return {
          title: document.title,
          description: get('meta[name="description"]'),
          ogTitle: get('meta[property="og:title"]'),
          ogDescription: get('meta[property="og:description"]'),
          twitterTitle: get('meta[name="twitter:title"]'),
          twitterDescription: get('meta[name="twitter:description"]'),
          ogImage: get('meta[property="og:image"]'),
          twitterImage: get('meta[name="twitter:image"]'),
          htmlLang: document.documentElement.lang,
        };
      });

      const fail = (msg) => failures.push({ lang, path, msg, meta });

      // Required tags present + non-empty
      for (const k of ["title", "description", "ogTitle", "ogDescription", "twitterTitle", "twitterDescription"]) {
        if (!meta[k] || !meta[k].trim()) fail(`missing ${k}`);
      }

      // Language heuristic
      const pat = LANG_PATTERNS[lang];
      for (const k of ["title", "description"]) {
        if (meta[k] && !pat.test(meta[k])) fail(`${k} not in ${lang}: "${meta[k].slice(0, 60)}"`);
      }

      // og:title/description should mirror title/description language
      if (meta.ogTitle && meta.ogDescription && meta.title && meta.description) {
        // ogTitle vs twitterTitle must match
        if (meta.ogTitle !== meta.twitterTitle) fail(`og:title ≠ twitter:title`);
        if (meta.ogDescription !== meta.twitterDescription) fail(`og:desc ≠ twitter:desc`);
      }

      // og:image leakage
      if (expectImage) {
        if (!meta.ogImage) fail(`expected og:image but none set`);
        if (meta.ogImage !== meta.twitterImage) fail(`og:image ≠ twitter:image`);
      } else {
        if (meta.ogImage) fail(`stale og:image leaked: ${meta.ogImage}`);
        if (meta.twitterImage) fail(`stale twitter:image leaked: ${meta.twitterImage}`);
      }

      // html lang attribute reflects current language
      const expectedHtmlLang = lang === "zh" ? "zh-Hant" : lang;
      if (meta.htmlLang !== expectedHtmlLang) fail(`<html lang> = "${meta.htmlLang}", expected "${expectedHtmlLang}"`);

      const status = failures.some((f) => f.lang === lang && f.path === path) ? "✗" : "✓";
      console.log(`  ${status} [${lang}] ${path.padEnd(14)} → ${meta.title?.slice(0, 50) ?? "(no title)"}`);
    }
    console.log("");
  }

  await browser.close();
  if (serverProc) serverProc.kill();

  if (failures.length) {
    console.error(`\n✗ ${failures.length} failure(s):\n`);
    for (const f of failures) {
      console.error(`  [${f.lang}] ${f.path}: ${f.msg}`);
    }
    process.exit(1);
  }
  console.log(`\n✓ All ${ROUTES.length * LANGS.length} (route × lang) combinations passed.`);
}

main().catch((e) => {
  console.error(e);
  if (serverProc) serverProc.kill();
  process.exit(1);
});
