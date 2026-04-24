import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { VISIT, SOCIAL } from "@/data/site";

export const Route = createFileRoute("/visit")({
  head: () => ({
    meta: [
      { title: "來店資訊｜小時光書店" },
      { name: "description", content: "華山文創園區．紅磚六合院 西7-3館。週一至週日 11:00–19:00。" },
      { property: "og:title", content: "來店資訊｜小時光書店" },
      { property: "og:description", content: "華山文創園區．紅磚六合院 西7-3館。" },
    ],
  }),
  component: Visit,
});

function Visit() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Visit  ／  來店資訊"
        title="走進小時光"
        intro="一處藏在紅磚六合院裡的閱讀場域。歡迎在週間午後或週末傍晚，帶一本你正在讀的書，來坐一會兒。"
      />

      <section className="container-editorial pb-20">
        <div className="aspect-[16/9] bg-muted">
          <iframe
            src={VISIT.mapEmbed}
            className="h-full w-full border-0"
            loading="lazy"
            title="店址地圖"
          />
        </div>
      </section>

      <section className="container-editorial pb-32 grid gap-16 md:grid-cols-2">
        <div>
          <p className="eyebrow">Address  ／  店址</p>
          <h3 className="display mt-3 text-2xl">📍 {VISIT.address}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{VISIT.city}</p>

          <div className="mt-10">
            <p className="eyebrow">Hours  ／  營業時間</p>
            <p className="mt-3 text-base">🕒 {VISIT.hours}</p>
            <p className="mt-1 text-sm text-muted-foreground">{VISIT.closed}</p>
          </div>

          <div className="mt-10 flex flex-wrap gap-4 text-xs tracking-widest">
            <a href={VISIT.mapLink} target="_blank" rel="noreferrer" className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors">一鍵導航</a>
            <Link to="/contact" className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors">聯絡我們</Link>
            <a href={SOCIAL.instagram} target="_blank" rel="noreferrer" className="self-center text-clay hover-underline">@intervalbookstw</a>
          </div>
        </div>

        <div className="space-y-10">
          <div>
            <p className="eyebrow">Getting Here  ／  交通方式</p>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-foreground/80">
              <li>· 捷運忠孝新生站 1 號出口，步行約 6 分鐘</li>
              <li>· 捷運善導寺站 6 號出口，步行約 10 分鐘</li>
              <li>· 鄰近華山停車場、富邦藝旅停車場</li>
              <li>· 騎乘 YouBike：華山公園站、忠孝國小站</li>
            </ul>
          </div>
          <div>
            <p className="eyebrow">Inside  ／  店內體驗</p>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-foreground/80">
              <li>· 自選茶點與小份量甜食</li>
              <li>· 安靜閱讀座位（請小聲交談）</li>
              <li>· 不定期舉辦讀書會、講座與身心靈活動</li>
              <li>· 可詢問主理人選書與選品建議</li>
            </ul>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
