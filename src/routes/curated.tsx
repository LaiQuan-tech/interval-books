/**
 * /curated —— 只剩轉址。
 *
 * 2026-09-02 導覽列從九格收成五格，主理人的選品搬進「選物」的分頁
 * （src/routes/shop.index.tsx ＋ src/components/shop/CuratedPanel.tsx）。
 *
 * 保留網址的理由與 /publications 相同：外部連結不該因為站內重整而變成 404。
 * 沒有 component，也沒有 useDocumentMeta —— 說明見 src/routes/publications.tsx。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/curated")({
  beforeLoad: () => {
    throw redirect({ to: "/shop", search: { tab: "curated" }, statusCode: 301 });
  },
});
