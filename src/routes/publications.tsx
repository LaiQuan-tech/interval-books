/**
 * /publications —— 只剩轉址。
 *
 * 2026-09-02 導覽列從九格收成五格，地方刊物展搬進「選物」的分頁
 * （src/routes/shop.index.tsx ＋ src/components/shop/PublicationsPanel.tsx）。
 *
 * 這個檔案刻意**不刪**：這個網址散在 Google 商家、名片與社群貼文上，刪掉檔案等於
 * 讓那些連結全部撞 404。留一個 301，舊連結照樣到得了新家，搜尋引擎也知道搬去哪。
 *
 * 沒有 component，也沒有 useDocumentMeta —— beforeLoad 會先丟出去，元件永遠不會
 * 被畫出來，掛 meta 在上面只是掛一段證明不會被執行的程式碼。
 * scripts/check-meta.mjs 認得這個形狀（沒有 component ＋ beforeLoad 裡 throw
 * redirect），會把它算成轉址路由而不是「漏掉 meta 的頁面」。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/publications")({
  beforeLoad: () => {
    throw redirect({ to: "/shop", search: { tab: "publications" }, statusCode: 301 });
  },
});
