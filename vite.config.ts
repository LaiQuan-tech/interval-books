// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// 部署目標為 Vercel（原 Lovable 預設為 cloudflare-module）。
// nitro 預設只在 Lovable sandbox 內啟用，自行部署時必須明確開啟。
export default defineConfig({
  nitro: {
    preset: "vercel",
    // lovable 預設把 output 寫死成 dist/{server,client}，會打亂 Vercel
    // Build Output API v3 要求的 static/ + functions/__server.func/ 結構。
    output: {
      dir: ".vercel/output",
      publicDir: ".vercel/output/static",
      serverDir: ".vercel/output/functions/__server.func",
    },
  },
});
