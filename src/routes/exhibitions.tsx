import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { exhibitions } from "@/data/site";
import interiorImg from "@/assets/bookstore-interior.jpg";
import exhibitionImg from "@/assets/exhibition-corner.jpg";

const IMAGES: Record<string, string> = {
  "soil-and-page": interiorImg,
  "quiet-objects": exhibitionImg,
};

export const Route = createFileRoute("/exhibitions")({
  head: () => ({
    meta: [
      { title: "展覽｜小時光書店" },
      { name: "description", content: "風土、文字、器物的策展現場——當期與下檔展覽彙整。" },
      { property: "og:title", content: "展覽｜小時光書店" },
      { property: "og:description", content: "策展現場：風土、文字、器物。" },
      { property: "og:image", content: exhibitionImg },
    ],
  }),
  component: Exhibitions,
});

function Exhibitions() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Exhibitions  ／  展覽"
        title="在書頁與展牆之間"
        intro="我們以小型策展的節奏經營展覽，每一檔展覽都嘗試讓文字、影像與器物對話。"
      />

      <section className="container-editorial pb-32 space-y-32">
        {exhibitions.map((ex, i) => (
          <article key={ex.slug} id={ex.slug} className="grid md:grid-cols-12 gap-10 lg:gap-16 scroll-mt-24">
            <div className={`md:col-span-7 ${i % 2 === 1 ? "md:order-2" : ""}`}>
              <div className="aspect-[4/3] overflow-hidden bg-muted">
                <img src={IMAGES[ex.slug]} alt={ex.title} loading="lazy" className="h-full w-full object-cover" />
              </div>
            </div>
            <div className="md:col-span-5 flex flex-col justify-center">
              <p className="eyebrow">{ex.period}</p>
              <h2 className="display mt-4 text-4xl md:text-5xl">{ex.title}</h2>
              <p className="mt-3 text-sm text-muted-foreground">{ex.location}</p>
              <div className="rule mt-6" />
              <p className="mt-6 text-base leading-relaxed text-foreground/80">{ex.blurb}</p>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{ex.statement}</p>
              <p className="mt-8 text-xs text-muted-foreground tracking-widest">參觀方式  ／  營業時間內自由參觀，無需預約</p>
            </div>
          </article>
        ))}
      </section>
    </PageShell>
  );
}
