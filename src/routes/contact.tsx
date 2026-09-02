/**
 * /contact —— 只剩轉址。
 *
 * 2026-09-02 導覽列從九格收成五格。這一頁是**純移除**，不是搬家：它上面的每一項
 * （Email、兩支電話、官網、社群）SiteFooter 已經逐項都有，而且來源是同一份
 * useSiteContent() —— 同一張 site_settings ／ contact_phones，不是抄過去的複本。
 * 所以沒有東西需要搬到 /about，footer 一個字都不用改。
 *
 * 網址仍然保留並轉去 /about（那裡有地址、營業時間、地圖與 Email 按鈕），理由與
 * /visit 相同：外部連結不該因為站內重整而變成 404。
 *
 * 沒有 component，也沒有 useDocumentMeta —— 說明見 src/routes/publications.tsx。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/contact")({
  beforeLoad: () => {
    throw redirect({ to: "/about", statusCode: 301 });
  },
});
