import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchPage, pageText } from "@/lib/cms";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "隱私權 Privacy｜小時光書店 Interval Books",
    en: "Privacy｜Interval Books",
    ja: "プライバシー｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "小時光書店之隱私權聲明。",
    en: "Privacy statement of Interval Books.",
    ja: "小時光書店のプライバシーに関する声明。",
  },
  title: { zh: "隱私權聲明", en: "Privacy Statement", ja: "プライバシー" },
  body: {
    zh: "小時光書店尊重每一位讀者與來訪者的個人資訊。本網站僅作為品牌、活動、選品與來店資訊之展示用途，目前不收集個人帳號、付款資訊或會員資料。若您透過 Email 與我們聯繫，您所提供的姓名與聯絡方式僅用於回覆與後續合作溝通，不會被轉作他用，亦不會與第三方分享。第三方嵌入服務（如 Google Maps、Instagram）可能依其自身政策蒐集使用紀錄，請參閱該服務之隱私聲明。本聲明可能依實際營運狀況更新，更新版本將直接公佈於本頁。",
    en: "Interval Books respects the privacy of every reader and visitor. This site exists to present our brand, events, curated objects, and visit information; we do not currently collect accounts, payment data, or member records. If you reach us by email, the name and contact details you share are used only to reply and to continue our conversation — never repurposed or shared with third parties. Third-party embeds (such as Google Maps and Instagram) may collect usage data under their own policies; please see those services' notices. This statement may be updated as operations evolve, and any new version will be posted on this page.",
    ja: "小時光書店は、読者と来訪者おひとりおひとりの個人情報を尊重します。本サイトはブランド・イベント・選品・ご来店案内を提示する目的で運営されており、現在のところアカウント、決済情報、会員情報は取得しておりません。メールでご連絡いただいた際の氏名・連絡先は、お返事とその後のやり取りのみに使用し、第三者に共有することはありません。Google Maps や Instagram などの埋め込みサービスは、各社のポリシーに基づき利用情報を収集する場合があります。詳細は各サービスのプライバシーポリシーをご参照ください。本声明は運営状況により更新される場合があり、最新版は本ページに掲載します。",
  },
};

export const Route = createFileRoute("/privacy")({
  loader: async () => ({ page: await fetchPage("privacy") }),
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
      ],
    };
  },
  component: Privacy,
});

function Privacy() {
  const t = useT();
  const { page } = Route.useLoaderData();
  const p = pageText(page);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
  });

  return (
    <PageShell>
      <PageHeader eyebrow={page?.eyebrowPrefix ?? "Privacy"} title={t(p.title(PAGE.title))} />
      <section className="container-editorial pb-32 max-w-3xl">
        <p className="text-base leading-loose text-foreground/80">
          {t(p.block("body", PAGE.body))}
        </p>
      </section>
    </PageShell>
  );
}
