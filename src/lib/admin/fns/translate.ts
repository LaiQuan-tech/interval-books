/**
 * 三語欄位「自動翻譯」的 server function。
 *
 * ── 為什麼是 server fn，不是瀏覽器直接打 Gemini ───────────────────────────
 * **金鑰不進瀏覽器。** 這一條沒有例外：任何在 client 端讀得到的東西都等於公開，
 * 而 Gemini 的金鑰是一張可以被別人拿去刷的帳單。src/server/** 的 import 保護
 * （behavior: "error"）會讓「不小心從 client 匯入」直接 build 失敗，這支 fn 就是
 * 那道牆上唯一的門。src/server/translate.ts 也因此只在 handler 裡動態 import。
 *
 * ── 掛 adminFnMiddleware ─────────────────────────────────────────────────
 * 翻譯會花錢，而且花的是整個站共用的額度。內容管理本來就是 admin 的事，所以沿用
 * 守著其他 CMS 函式的那一支，一個字都沒有放寬。
 *
 * ⚠️ 已知的邊界：/admin/inventory-products 等幾個頁面是 `staff: true`，店員在那裡
 *    看得到 LocalizedField。店員按下自動翻譯會被這支 middleware 擋下來 —— 那是**刻意
 *    的**，而且不是靜默失敗：前端會跳一個 toast，兩個框維持空白且攤開，店員照樣可以
 *    按「複製中文到英日」或自己打。要放寬的話是換成 staffFnMiddleware()，那是一個
 *    獨立的決定（誰可以燒站台的 AI 額度），不該混在這一期裡順手做掉。
 */
import { createServerFn } from "@tanstack/react-start";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { translateSchema } from "@/lib/admin/schemas";
import type { TranslateFailureKindValue } from "@/lib/admin/schemas";

/**
 * 翻譯的回傳。**失敗不 throw，回一個 ok:false** —— 與 fns/ocr.ts 同一個慣例，
 * 也與這個專案其他 server fn（錯誤一律 throw）刻意不同。
 *
 * 理由一樣：失敗的種類決定畫面要說什麼。額度用完要說「稍後再試」、逾時要說「可以
 * 再按一次」、格式壞掉要說「把中文拆短」。throw 之後前端只剩一句字串可以比對。
 *
 * ⚠️ 真正的授權失敗仍然是 throw（middleware 丟的），不會變成 ok:false。前端那一側
 *    有 catch 把它收成一句人話，見 LocalizedField.tsx。
 */
export type TranslateResponse =
  | { ok: true; data: { en: string; ja: string } }
  | { ok: false; kind: TranslateFailureKindValue; message: string };

export const translateToEnJa = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(translateSchema)
  .handler(async ({ data }): Promise<TranslateResponse> => {
    const { translateToEnJa, TranslateError } = await import("@/server/translate");
    try {
      // ⚠️ 這裡回的兩個字串保證都 trim 過而且非空 —— translate.ts 的
      //    normaliseTranslation() 擋掉了空的那一種。前端拿不到空字串可以寫進
      //    jsonb，因為 is_localized() 的 CHECK 只看 key 存不存在，空字串會過。
      return { ok: true, data: await translateToEnJa({ text: data.text }) };
    } catch (err) {
      if (err instanceof TranslateError) {
        return { ok: false, kind: err.kind, message: err.message };
      }
      // 不是翻譯失敗，是真的壞了（例如缺 GEMINI_API_KEY 這種設定錯誤）。照丟。
      throw err;
    }
  });
