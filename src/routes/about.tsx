import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import interiorImg from "@/assets/bookstore-interior.jpg";
import curatedImg from "@/assets/curated-objects.jpg";
import journeyImg from "@/assets/journey-mist.jpg";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "關於小時光｜小時光書店" },
      { name: "description", content: "以策展為方法，書、選物、陶藝、茶點，匯流為一處安靜而深刻的閱讀與生活場域。" },
      { property: "og:title", content: "關於小時光" },
      { property: "og:description", content: "以策展為方法的閱讀與生活場域。" },
      { property: "og:image", content: interiorImg },
    ],
  }),
  component: About,
});

function About() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="About  ／  關於小時光"
        title="一處安靜的閱讀與生活場域"
        intro="我們相信書與器物有同樣的份量。書頁是被捻平的土地，陶土則是被烘烤的時間。小時光以策展為方法，把這些緩慢的事物放在一起，邀請讀者走進、停留、再離開時帶走一些什麼。"
      />

      <section className="container-editorial pb-20">
        <div className="aspect-[16/9] overflow-hidden bg-muted">
          <img src={interiorImg} alt="小時光書店空間" className="h-full w-full object-cover" />
        </div>
      </section>

      <section className="container-editorial pb-24">
        <p className="eyebrow">Three Practices  ／  我們的三種專長</p>
        <div className="mt-10 grid gap-px bg-border border border-border md:grid-cols-3">
          {[
            { n: "01", title: "風土誌書展策展", desc: "以一塊土地、一個議題為線索，串連書、作者、出版社與在地故事。" },
            { n: "02", title: "身心靈與閱讀活動", desc: "讀書會、靜走、聲音療癒——讓書與身體一起呼吸。" },
            { n: "03", title: "策旅與合作共創", desc: "走出店外，與在地夥伴共同設計風土主題的深度旅程。" },
          ].map((it) => (
            <div key={it.n} className="bg-background p-10">
              <p className="font-serif text-2xl text-clay">{it.n}</p>
              <h3 className="display mt-6 text-2xl">{it.title}</h3>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{it.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container-editorial pb-32">
        <p className="eyebrow">Our Space  ／  空間特色</p>
        <h2 className="display mt-5 text-3xl md:text-4xl max-w-2xl">書、選物、陶藝、茶點、聚會——在留白之中各自發聲。</h2>
        <div className="mt-12 grid gap-8 md:grid-cols-2">
          <figure>
            <div className="aspect-[4/3] overflow-hidden bg-muted">
              <img src={curatedImg} alt="器物與書" loading="lazy" className="h-full w-full object-cover" />
            </div>
            <figcaption className="mt-4 text-sm text-muted-foreground">手作器物與地方選書，並陳於同一張長桌。</figcaption>
          </figure>
          <figure>
            <div className="aspect-[4/3] overflow-hidden bg-muted">
              <img src={journeyImg} alt="策旅意象" loading="lazy" className="h-full w-full object-cover" />
            </div>
            <figcaption className="mt-4 text-sm text-muted-foreground">從店內延伸至山徑與海岸的策旅實驗。</figcaption>
          </figure>
        </div>
      </section>
    </PageShell>
  );
}
