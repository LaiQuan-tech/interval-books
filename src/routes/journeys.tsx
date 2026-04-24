import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { journeys, CONTACT_EMAIL } from "@/data/site";
import { CurationForm } from "./curation";
import journeyImg from "@/assets/journey-mist.jpg";

export const Route = createFileRoute("/journeys")({
  head: () => ({
    meta: [
      { title: "策旅｜小時光書店" },
      { name: "description", content: "從書頁走入山徑與海岸——以風土為主題的深度策旅。" },
      { property: "og:title", content: "策旅｜小時光書店" },
      { property: "og:description", content: "深度風土主題策旅。" },
      { property: "og:image", content: journeyImg },
    ],
  }),
  component: Journeys,
});

function Journeys() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Journeys  ／  策旅"
        title="從書頁，走入風土"
        intro="每一趟策旅都有獨立的網站。本頁為彙整與導流，讓你看見小時光走出店外的另一種樣貌。"
      />

      <section className="container-editorial pb-24 grid gap-12 md:grid-cols-2 lg:grid-cols-3">
        {journeys.map((j) => (
          <article key={j.title} className="flex flex-col">
            <div className="aspect-[4/5] overflow-hidden bg-muted">
              <img src={journeyImg} alt={j.title} loading="lazy" className="h-full w-full object-cover" />
            </div>
            <p className="eyebrow mt-6">{j.days}  ／  {j.theme}</p>
            <h3 className="display mt-3 text-2xl leading-snug">{j.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground flex-1">{j.blurb}</p>
            <a
              href={j.url}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-block self-start text-xs tracking-widest text-clay hover-underline"
            >
              前往旅程網站  →
            </a>
          </article>
        ))}
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 grid lg:grid-cols-2 gap-12">
          <div>
            <p className="eyebrow">Co-Create  ／  策旅合作共創</p>
            <h2 className="display mt-5 text-4xl">與在地夥伴<br/>共寫一段旅程</h2>
            <p className="mt-6 text-base leading-relaxed text-foreground/75 max-w-md">
              如果你來自旅宿、品牌、地方創生團隊，歡迎與我們一起策劃下一段旅程。
            </p>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="mt-8 inline-block border border-foreground px-6 py-3 text-xs tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors"
            >
              Email 聯繫  ／  {CONTACT_EMAIL}
            </a>
          </div>
          <CurationForm />
        </div>
      </section>
    </PageShell>
  );
}
