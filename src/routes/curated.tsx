import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { curatedThemes, CONTACT_EMAIL, SOCIAL } from "@/data/site";
import curatedImg from "@/assets/curated-objects.jpg";

export const Route = createFileRoute("/curated")({
  head: () => ({
    meta: [
      { title: "主理人的選品｜小時光書店" },
      { name: "description", content: "以櫥窗而非貨架——地方風土、器物與陶、茶點小物，由主理人親選。" },
      { property: "og:title", content: "主理人的選品｜小時光書店" },
      { property: "og:description", content: "策展式櫥窗，由主理人親選。" },
      { property: "og:image", content: curatedImg },
    ],
  }),
  component: Curated,
});

function Curated() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Curated  ／  主理人的選品"
        title="以櫥窗，而非貨架"
        intro="這裡沒有商品清單、沒有價格標籤。每一只器物、每一份茶點，都是被主理人留下來的緩慢時間。歡迎到店感受、詢問、帶走。"
      />

      <section className="container-editorial pb-20">
        <div className="aspect-[16/8] overflow-hidden bg-muted">
          <img src={curatedImg} alt="主理人選品" className="h-full w-full object-cover" />
        </div>
      </section>

      <section className="container-editorial pb-32 space-y-24">
        {curatedThemes.map((theme, idx) => (
          <div key={theme.title}>
            <div className="flex items-baseline gap-6 border-b border-border pb-6">
              <p className="font-serif text-2xl text-clay">0{idx + 1}</p>
              <div>
                <h2 className="display text-3xl md:text-4xl">{theme.title}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{theme.description}</p>
              </div>
            </div>
            <div className="mt-10 grid gap-px bg-border border border-border sm:grid-cols-2 lg:grid-cols-3">
              {theme.items.map((it) => (
                <div key={it.name} className="bg-background p-6 min-h-32">
                  <h3 className="font-serif text-lg">{it.name}</h3>
                  <p className="mt-2 text-xs text-muted-foreground tracking-wide">{it.note}</p>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="border-t border-border pt-16">
          <p className="eyebrow">How to Buy  ／  購買方式</p>
          <h2 className="display mt-4 text-3xl max-w-2xl">不做電商，只在店裡相遇。</h2>
          <p className="mt-4 text-sm text-muted-foreground max-w-xl">
            選品數量有限，無法線上下單。歡迎到店挑選，或透過 Email、LINE 私訊我們詢問細節。
          </p>
          <div className="mt-8 flex flex-wrap gap-4 text-xs tracking-widest">
            <a href={SOCIAL.instagram} target="_blank" rel="noreferrer" className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors">到店選購</a>
            <a href={`mailto:${CONTACT_EMAIL}`} className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors">Email 詢問</a>
            <a href={SOCIAL.line} target="_blank" rel="noreferrer" className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors">LINE 私訊</a>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
