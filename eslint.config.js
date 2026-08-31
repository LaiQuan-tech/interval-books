import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // ── 為什麼這份清單這麼長 ──────────────────────────────────────────────
    // flat config 只預設忽略 node_modules 與 .git，其餘一律會走進去，而且它
    // **不讀 .gitignore，也不讀 .prettierignore**。`eslint .` 因此會走進三類
    // 「不是本專案原始碼」的東西，跑超過兩分鐘、噴出上萬個錯誤：
    //
    //   1. 建置產物 —— .vercel/output 底下有 413 個打包後的 .js
    //   2. 別的 session 留下的 worktree —— .claude/worktrees 是整份 repo 的
    //      複本（620MB），還帶著它自己的建置產物
    //   3. 進銷存合併用的來源專案複本 —— 三個中文目錄，共 334 個檔案
    //
    // 這些加起來約 1052 個外來檔案，而本專案自己的原始碼只有 336 個。也就是
    // 說 lint 有四分之三的時間在檢查別人的東西。一個永遠跑不完、永遠不綠的
    // lint 等於沒有 lint —— 每一期的 agent 都學會了忽略它。
    ignores: [
      "dist",
      ".output",
      ".vinxi",
      ".tanstack",
      ".vercel",
      ".claude",
      "reports",
      "node_modules",
      // TanStack Router 產生的路由表。格式由產生器決定，每次 build 都會重寫，
      // 所以人去改它是沒有意義的。.prettierignore 已經排除它了，但
      // eslint-plugin-prettier 不讀 .prettierignore，這裡必須再寫一次 ——
      // 否則 --fix 排好的格式會在下一次 build 被產生器蓋回去，lint 就又紅了。
      "src/routeTree.gen.ts",
      // 見 .gitignore 的說明：這三個是「搬移改寫進 src/ 之後就該刪掉」的來源
      // 專案複本，不是本專案的原始碼，不該被 lint，更不該被 --fix 改寫。
      "小時光書店進銷存",
      "小時光 書店官方網站 v3",
      "小時光書店風土誌講座",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // ── 全形空格是內容，不是 bug ────────────────────────────────────────
      // 這個 codebase 的 UI 文案大量使用全形空格（U+3000）作為中日文的排版
      // 間隔，例如「Instagram　@intervalbookstw」、「平日 40 ／小時　|　假日」。
      // 另外 src/lib/csv.ts 開頭的 U+FEFF 是**刻意的 BOM**，Excel 靠它判斷
      // 編碼（roster-csv-selftest 有一條 charCodeAt(0) === 0xfeff 在守它）。
      //
      // ESLint 預設就已經 skipStrings —— 也就是說它自己也認為「字串字面值裡的
      // 空白是內容」。但樣板字串與 JSX 文字同樣是內容，卻預設不被跳過，於是
      // 那 5 個地方全都是誤報。把這兩種情境一併跳過，是延續這條規則本來的判準，
      // 而不是放寬它：程式碼結構裡（token 之間、註解、正規表示式）的異常空白
      // 仍然會被抓出來，那才是這條規則真正要防的 bug。
      //
      // 反過來做（把字元刪掉讓數字歸零）會竄改客人看得到的文案，並且弄壞 CSV
      // 的 Excel 相容性。
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipTemplates: true, skipJSXText: true },
      ],
    },
  },
  eslintPluginPrettier,
);
