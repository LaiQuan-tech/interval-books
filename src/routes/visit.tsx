import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import { useSiteContent } from "@/lib/site-content";
import type { Localized } from "@/i18n/types";

export const Route = createFileRoute("/visit")({
  loader: async () => ({ page: await fetchPage("visit") }),
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
      ],
    };
  },
  component: Visit,
});

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "來店資訊 Visit｜小時光書店 Interval Books",
    en: "Visit｜Interval Books",
    ja: "ご来店｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "華山文創園區．紅磚六合院 西7-3館。週一至週日 11:00–19:00。捷運忠孝新生站步行 3 分鐘。",
    en: "Huashan 1914 Creative Park, Red Brick Courtyard, West 7-3. Open daily 11:00–19:00. 3 min walk from MRT Zhongxiao Xinsheng.",
    ja: "華山1914文化創意産業園區 紅煉瓦六合院 西7-3館。月〜日 11:00–19:00。MRT 忠孝新生駅から徒歩3分。",
  },
  eyebrowSuffix: { zh: "來店資訊", en: "Visit", ja: "ご来店" },
  title: { zh: "走進小時光", en: "Step inside the interval", ja: "小時光へ" },
  intro: {
    zh: "一處藏在紅磚六合院裡的閱讀場域。歡迎在週間午後或週末傍晚，帶一本你正在讀的書，來坐一會兒。",
    en: "A reading space tucked inside the Red Brick Courtyard. Drop by on a quiet afternoon with the book you're reading.",
    ja: "紅煉瓦六合院に佇む読書の場所。平日の午後や週末の夕暮れに、いま読んでいる本を抱えてお越しください。",
  },
  address: { zh: "店址", en: "Address", ja: "ご住所" },
  hours: { zh: "營業時間", en: "Hours", ja: "営業時間" },
  transport: { zh: "交通方式", en: "Getting Here", ja: "アクセス" },
  metro: { zh: "捷運", en: "Metro (MRT)", ja: "MRT" },
  bus: { zh: "公車", en: "Bus", ja: "バス" },
  drive: { zh: "開車・停車", en: "By car & parking", ja: "お車・駐車" },
  walk: { zh: "步行路線", en: "On foot", ja: "徒歩でのご案内" },
  inside: { zh: "店內體驗", en: "Inside", ja: "店内のこと" },
  busDetail: { zh: "查看公車路線", en: "View bus routes", ja: "バス路線を見る" },
  contactUs: { zh: "聯絡我們", en: "Contact us", ja: "お問合せ" },
  navHint: {
    zh: "一鍵開啟導航，帶你走進紅磚六合院。",
    en: "One tap to open turn-by-turn navigation to the Red Brick Courtyard.",
    ja: "ワンタップで紅煉瓦六合院までのナビを開きます。",
  },
  openGoogle: { zh: "Google Maps 導航", en: "Open in Google Maps", ja: "Google マップで開く" },
  openApple: { zh: "Apple 地圖導航", en: "Open in Apple Maps", ja: "Apple マップで開く" },
  navigateEyebrow: { zh: "Navigate", en: "Navigate", ja: "Navigate" },
  contactEyebrow: { zh: "Contact", en: "Contact", ja: "Contact" },
};

const METRO: Localized[] = [
  {
    zh: "板南線「忠孝新生站」1 號出口，步行約 3 分鐘",
    en: "Bannan Line, Zhongxiao Xinsheng Station, Exit 1 — about 3 min on foot",
    ja: "板南線「忠孝新生」駅 1 番出口より徒歩約 3 分",
  },
  {
    zh: "或「善導寺站」6 號出口，步行約 5 分鐘",
    en: "Or Shandao Temple Station, Exit 6 — about 5 min on foot",
    ja: "または「善導寺」駅 6 番出口より徒歩約 5 分",
  },
];

const BUS: Localized[] = [
  {
    zh: "忠孝國小站：232、232(副)、605 系列、665",
    en: "Zhongxiao Elementary School stop (忠孝國小): 232, 232(sub), 605 series, 665",
    ja: "忠孝國小停留所：232、232(副)、605 系統、665",
  },
  {
    zh: "華山公園站：669",
    en: "Huashan Park stop (華山公園): 669",
    ja: "華山公園停留所：669",
  },
  {
    zh: "審計部（忠孝東路）：205、232、262(區間)、276、299、忠孝新幹線",
    en: "National Audit Office on Zhongxiao E. Rd. (審計部): 205, 232, 262(local), 276, 299, Zhongxiao Express",
    ja: "審計部（忠孝東路）停留所：205、232、262(区間)、276、299、忠孝新幹線",
  },
];

const DRIVE: Localized[] = [
  {
    zh: "園區附設 24 小時停車場（出入口位於八德路一段）",
    en: "On-site 24-hour parking lot (entrance on Bade Rd. Sec. 1)",
    ja: "園内に 24 時間駐車場あり（入口は八德路一段）",
  },
  {
    zh: "平日 TWD 40 ／小時　|　假日 TWD 60 ／小時",
    en: "Weekdays TWD 40 / hr  ·  Weekends TWD 60 / hr",
    ja: "平日 TWD 40 / 時　|　休日 TWD 60 / 時",
  },
  {
    zh: "建議：假日車位緊張，可改搭捷運前往。",
    en: "Tip: weekend parking fills quickly — MRT is recommended.",
    ja: "ヒント：週末は満車になりやすいため、MRT のご利用がおすすめです。",
  },
];

const WALK: Localized[] = [
  {
    zh: "從忠孝新生站 1 號出口出來，沿金山北路向北步行約 200 公尺。",
    en: "From MRT Zhongxiao Xinsheng Exit 1, walk north on Jinshan N. Rd. for ~200 m.",
    ja: "忠孝新生駅 1 番出口から金山北路を北へ約 200 m。",
  },
  {
    zh: "看到紅磚老建築群即進入園區，沿主道走至「紅磚六合院」。",
    en: "Enter the park when you see the red-brick warehouses, then head to the Red Brick Courtyard.",
    ja: "赤煉瓦倉庫群が見えたら園内へ。メイン通りに沿って「紅煉瓦六合院」へ。",
  },
  {
    zh: "穿過六合院中庭，西側第三間即為「西 7-3 館」。",
    en: "Cross the courtyard — West 7-3 is the third unit on the west side.",
    ja: "中庭を抜けた西側 3 番目が「西 7-3 館」です。",
  },
];

const INSIDE: Localized[] = [
  {
    zh: "自選茶點與小份量甜食",
    en: "Self-serve tea and small sweets",
    ja: "セルフのお茶と小ぶりな甘いもの",
  },
  {
    zh: "安靜閱讀座位（請小聲交談）",
    en: "Quiet reading seats (please keep voices low)",
    ja: "静かな読書席（小声でどうぞ）",
  },
  {
    zh: "不定期舉辦讀書會、講座與身心靈活動",
    en: "Occasional reading circles, talks, and healing sessions",
    ja: "読書会、トーク、ヒーリングを随時開催",
  },
  {
    zh: "可詢問主理人選書與選品建議",
    en: "Ask the owner for book and object recommendations",
    ja: "店主におすすめの本や品をお気軽にご相談ください",
  },
];

function Visit() {
  const t = useT();
  const { page } = Route.useLoaderData();
  const p = pageText(page);
  const { site, map, social, ui } = useSiteContent();

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
  });

  const [busOpen, setBusOpen] = useState(false);

  const metroList = p.list("metro", METRO);
  const busList = p.list("bus", BUS);
  const driveList = p.list("drive", DRIVE);
  const walkList = p.list("walk", WALK);
  const insideList = p.list("inside", INSIDE);

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Visit", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      {/* Map */}
      <section className="container-editorial pb-16">
        <div className="aspect-[16/9] bg-muted">
          <iframe src={map.embed} className="h-full w-full border-0" loading="lazy" title="Map" />
        </div>
      </section>

      {/* 1) 地址 + 營業時間 */}
      <section className="container-editorial pb-16 grid gap-12 md:grid-cols-2">
        <div>
          <p className="eyebrow text-2xl">{t(p.block("address", PAGE.address))}</p>
          <h3 className="display mt-3 text-2xl">{t(site.address)}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{t(site.city)}</p>
        </div>
        <div>
          <p className="eyebrow text-2xl">{t(p.block("hours", PAGE.hours))}</p>
          <p className="mt-3 text-base">{t(site.hours)}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t(ui.footer.everyday)}</p>
        </div>
      </section>

      {/* 2) 一鍵導航 */}
      <section className="container-editorial pb-20">
        <div className="border border-border bg-[oklch(0.97_0.012_82)] p-8 md:p-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div className="max-w-md">
            <p className="eyebrow text-2xl">
              {t(p.block("navigateEyebrow", PAGE.navigateEyebrow))}
            </p>
            <h3 className="display mt-3 text-2xl md:text-3xl">{t(ui.buttons.navigate)}</h3>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
              {t(p.block("navHint", PAGE.navHint))}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 text-xs tracking-widest">
            <a
              href={map.link}
              target="_blank"
              rel="noreferrer"
              className="border border-foreground bg-foreground text-primary-foreground px-5 py-3 hover:opacity-90 transition-opacity"
            >
              {t(p.block("openGoogle", PAGE.openGoogle))}
            </a>
            <a
              href={map.apple}
              target="_blank"
              rel="noreferrer"
              className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
            >
              {t(p.block("openApple", PAGE.openApple))}
            </a>
          </div>
        </div>
      </section>

      {/* 3) 交通方式 */}
      <section className="container-editorial pb-24">
        <p className="eyebrow text-2xl border-t border-border pt-12">
          {t(p.block("transport", PAGE.transport))}
        </p>
        <div className="mt-10 grid gap-12 md:grid-cols-2 lg:grid-cols-4">
          {/* Metro */}
          <div>
            <h3 className="font-serif text-xl">{t(p.block("metro", PAGE.metro))}</h3>
            <div className="rule mt-3" />
            <ul className="mt-5 space-y-3 text-sm leading-relaxed text-foreground/80">
              {metroList.map((item, i) => (
                <li key={i}>· {t(item)}</li>
              ))}
            </ul>
          </div>

          {/* Walk */}
          <div>
            <h3 className="font-serif text-xl">{t(p.block("walk", PAGE.walk))}</h3>
            <div className="rule mt-3" />
            <ol className="mt-5 space-y-3 text-sm leading-relaxed text-foreground/80 list-decimal pl-5">
              {walkList.map((item, i) => (
                <li key={i}>{t(item)}</li>
              ))}
            </ol>
          </div>

          {/* Drive */}
          <div>
            <h3 className="font-serif text-xl">{t(p.block("drive", PAGE.drive))}</h3>
            <div className="rule mt-3" />
            <ul className="mt-5 space-y-3 text-sm leading-relaxed text-foreground/80">
              {driveList.map((item, i) => (
                <li key={i}>· {t(item)}</li>
              ))}
            </ul>
          </div>

          {/* Bus (accordion) */}
          <div>
            <h3 className="font-serif text-xl">{t(p.block("bus", PAGE.bus))}</h3>
            <div className="rule mt-3" />
            <button
              onClick={() => setBusOpen((v) => !v)}
              className="mt-5 text-xs tracking-widest text-clay hover-underline"
            >
              {t(p.block("busDetail", PAGE.busDetail))} {busOpen ? "−" : "+"}
            </button>
            {busOpen && (
              <ul className="mt-5 space-y-3 text-xs leading-relaxed text-muted-foreground border-l-2 border-clay/40 pl-4">
                {busList.map((item, i) => (
                  <li key={i}>· {t(item)}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* 4) 店內體驗 + CTA */}
      <section className="container-editorial pb-32 grid gap-12 md:grid-cols-2">
        <div>
          <p className="eyebrow text-2xl border-t border-border pt-12">
            {t(p.block("inside", PAGE.inside))}
          </p>
          <ul className="mt-6 space-y-3 text-sm leading-relaxed text-foreground/80">
            {insideList.map((item, i) => (
              <li key={i}>· {t(item)}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="eyebrow text-2xl border-t border-border pt-12">
            {t(p.block("contactEyebrow", PAGE.contactEyebrow))}
          </p>
          <div className="mt-6 flex flex-wrap gap-4 text-xs tracking-widest">
            <Link
              to="/contact"
              className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
            >
              {t(p.block("contactUs", PAGE.contactUs))}
            </Link>
            <a
              href={social.instagram}
              target="_blank"
              rel="noreferrer"
              className="self-center text-clay hover-underline"
            >
              @intervalbookstw
            </a>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
