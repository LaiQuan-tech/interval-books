import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { UI, SITE_INFO, MAP, SOCIAL } from "@/i18n/strings";

export const Route = createFileRoute("/visit")({
  head: () => ({
    meta: [
      { title: "來店資訊 Visit｜小時光書店 Interval Books" },
      { name: "description", content: "華山文創園區．紅磚六合院 西7-3館。週一至週日 11:00–19:00。捷運忠孝新生站步行 3 分鐘。" },
      { property: "og:title", content: "來店資訊｜小時光書店" },
      { property: "og:description", content: "華山文創園區．紅磚六合院 西7-3館。" },
    ],
  }),
  component: Visit,
});

const PAGE = {
  title: { zh: "走進小時光", en: "Step inside the interval", ja: "小時光へ" },
  intro: {
    zh: "一處藏在紅磚六合院裡的閱讀場域。歡迎在週間午後或週末傍晚，帶一本你正在讀的書，來坐一會兒。",
    en: "A reading space tucked inside the Red Brick Courtyard. Drop by on a quiet afternoon with the book you're reading.",
    ja: "紅煉瓦六合院に佇む読書の場所。平日の午後や週末の夕暮れに、いま読んでいる本を抱えてお越しください。",
  },
  address: { zh: "店址", en: "Address", ja: "ご住所" },
  hours: { zh: "營業時間", en: "Hours", ja: "営業時間" },
  transport: { zh: "交通資訊", en: "Getting Here", ja: "アクセス" },
  metro: { zh: "捷運", en: "Metro (MRT)", ja: "MRT" },
  bus: { zh: "公車", en: "Bus", ja: "バス" },
  drive: { zh: "開車", en: "By car", ja: "お車" },
  inside: { zh: "店內體驗", en: "Inside", ja: "店内のこと" },
  busDetail: { zh: "查看公車路線", en: "View bus routes", ja: "バス路線を見る" },
  contactUs: { zh: "聯絡我們", en: "Contact us", ja: "お問合せ" },
  ig: { zh: "Instagram", en: "Instagram", ja: "Instagram" },
};

const METRO = {
  zh: [
    "板南線「忠孝新生站」1 號出口，步行約 3 分鐘",
    "或「善導寺站」6 號出口，步行約 5 分鐘",
  ],
  en: [
    "Bannan Line, Zhongxiao Xinsheng Station, Exit 1 — about 3 min on foot",
    "Or Shandao Temple Station, Exit 6 — about 5 min on foot",
  ],
  ja: [
    "板南線「忠孝新生」駅 1 番出口より徒歩約 3 分",
    "または「善導寺」駅 6 番出口より徒歩約 5 分",
  ],
};

const BUS = {
  zh: [
    "忠孝國小站：232、232(副)、605 系列、665",
    "華山公園站：669",
    "審計部（忠孝東路）：205、232、262(區間)、276、299、忠孝新幹線",
  ],
  en: [
    "Zhongxiao Elementary School stop (忠孝國小): 232, 232(sub), 605 series, 665",
    "Huashan Park stop (華山公園): 669",
    "National Audit Office on Zhongxiao E. Rd. (審計部): 205, 232, 262(local), 276, 299, Zhongxiao Express",
  ],
  ja: [
    "忠孝國小停留所：232、232(副)、605 系統、665",
    "華山公園停留所：669",
    "審計部（忠孝東路）停留所：205、232、262(区間)、276、299、忠孝新幹線",
  ],
};

const DRIVE = {
  zh: ["園區附設 24 小時停車場", "平日 TWD 40 ／小時　|　假日 TWD 60 ／小時"],
  en: ["Park's 24-hour parking lot on site", "Weekdays TWD 40 / hr  ·  Weekends TWD 60 / hr"],
  ja: ["園内の 24 時間駐車場をご利用いただけます", "平日 TWD 40 / 時　|　休日 TWD 60 / 時"],
};

const INSIDE = {
  zh: [
    "自選茶點與小份量甜食",
    "安靜閱讀座位（請小聲交談）",
    "不定期舉辦讀書會、講座與身心靈活動",
    "可詢問主理人選書與選品建議",
  ],
  en: [
    "Self-serve tea and small sweets",
    "Quiet reading seats (please keep voices low)",
    "Occasional reading circles, talks, and healing sessions",
    "Ask the owner for book and object recommendations",
  ],
  ja: [
    "セルフのお茶と小ぶりな甘いもの",
    "静かな読書席（小声でどうぞ）",
    "読書会、トーク、ヒーリングを随時開催",
    "店主におすすめの本や品をお気軽にご相談ください",
  ],
};

function Visit() {
  const t = useT();
  useDocumentMeta({
    title: {
      zh: "來店資訊 Visit｜小時光書店 Interval Books",
      en: "Visit｜Interval Books",
      ja: "ご来店｜小時光書店 Interval Books",
    },
    description: {
      zh: "華山文創園區．紅磚六合院 西7-3館。週一至週日 11:00–19:00。捷運忠孝新生站步行 3 分鐘。",
      en: "Huashan 1914 Creative Park, Red Brick Courtyard, West 7-3. Open daily 11:00–19:00. 3 min walk from MRT Zhongxiao Xinsheng.",
      ja: "華山1914文化創意産業園區 紅煉瓦六合院 西7-3館。月〜日 11:00–19:00。MRT 忠孝新生駅から徒歩3分。",
    },
    ogTitle: PAGE.title,
  });
  const [busOpen, setBusOpen] = useState(false);

  // pick array by current lang
  const lang = useT().toString; // dummy to satisfy ts; we use t() patterns below
  void lang;

  const pickList = (m: { zh: string[]; en: string[]; ja: string[] }) =>
    t({ zh: m.zh.join("\n"), en: m.en.join("\n"), ja: m.ja.join("\n") }).split("\n");

  return (
    <PageShell>
      <PageHeader
        eyebrow={`Visit  ／  ${t(UI.nav.visit)}`}
        title={t(PAGE.title)}
        intro={t(PAGE.intro)}
      />

      {/* Map */}
      <section className="container-editorial pb-16">
        <div className="aspect-[16/9] bg-muted">
          <iframe
            src={MAP.embed}
            className="h-full w-full border-0"
            loading="lazy"
            title="Map"
          />
        </div>
      </section>

      {/* 1) 地址 + 營業時間 */}
      <section className="container-editorial pb-16 grid gap-12 md:grid-cols-2">
        <div>
          <p className="eyebrow">{t(PAGE.address)}</p>
          <h3 className="display mt-3 text-2xl">{t(SITE_INFO.address)}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{t(SITE_INFO.city)}</p>
        </div>
        <div>
          <p className="eyebrow">{t(PAGE.hours)}</p>
          <p className="mt-3 text-base">{t(SITE_INFO.hours)}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t(UI.footer.everyday)}</p>
        </div>
      </section>

      {/* 2) 一鍵導航 */}
      <section className="container-editorial pb-20">
        <a
          href={MAP.link}
          target="_blank"
          rel="noreferrer"
          className="inline-block border border-foreground px-6 py-3 text-xs tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors"
        >
          {t(UI.buttons.navigate)}
        </a>
      </section>

      {/* 3) 交通資訊 */}
      <section className="container-editorial pb-24">
        <p className="eyebrow border-t border-border pt-12">{t(PAGE.transport)}</p>
        <div className="mt-10 grid gap-12 md:grid-cols-3">
          {/* Metro */}
          <div>
            <h3 className="font-serif text-xl">{t(PAGE.metro)}</h3>
            <div className="rule mt-3" />
            <ul className="mt-5 space-y-3 text-sm leading-relaxed text-foreground/80">
              {pickList(METRO).map((line, i) => (
                <li key={i}>· {line}</li>
              ))}
            </ul>
          </div>

          {/* Drive */}
          <div>
            <h3 className="font-serif text-xl">{t(PAGE.drive)}</h3>
            <div className="rule mt-3" />
            <ul className="mt-5 space-y-3 text-sm leading-relaxed text-foreground/80">
              {pickList(DRIVE).map((line, i) => (
                <li key={i}>· {line}</li>
              ))}
            </ul>
          </div>

          {/* Bus (accordion) */}
          <div>
            <h3 className="font-serif text-xl">{t(PAGE.bus)}</h3>
            <div className="rule mt-3" />
            <button
              onClick={() => setBusOpen((v) => !v)}
              className="mt-5 text-xs tracking-widest text-clay hover-underline"
            >
              {t(PAGE.busDetail)}  {busOpen ? "−" : "+"}
            </button>
            {busOpen && (
              <ul className="mt-5 space-y-3 text-xs leading-relaxed text-muted-foreground border-l-2 border-clay/40 pl-4">
                {pickList(BUS).map((line, i) => (
                  <li key={i}>· {line}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* 4) 店內體驗 + CTA */}
      <section className="container-editorial pb-32 grid gap-12 md:grid-cols-2">
        <div>
          <p className="eyebrow border-t border-border pt-12">{t(PAGE.inside)}</p>
          <ul className="mt-6 space-y-3 text-sm leading-relaxed text-foreground/80">
            {pickList(INSIDE).map((line, i) => (
              <li key={i}>· {line}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="eyebrow border-t border-border pt-12">Contact</p>
          <div className="mt-6 flex flex-wrap gap-4 text-xs tracking-widest">
            <Link to="/contact" className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors">
              {t(PAGE.contactUs)}
            </Link>
            <a href={SOCIAL.instagram} target="_blank" rel="noreferrer" className="self-center text-clay hover-underline">
              @intervalbookstw
            </a>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
