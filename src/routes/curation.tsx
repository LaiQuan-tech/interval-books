import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { collaborations, cases, CONTACT_EMAIL } from "@/data/site";
import interiorImg from "@/assets/bookstore-interior.jpg";

export const Route = createFileRoute("/curation")({
  head: () => ({
    meta: [
      { title: "策展與合作｜小時光書店" },
      { name: "description", content: "為品牌、空間、機構量身打造的書展、藝術合作、生活節與內容策展。" },
      { property: "og:title", content: "策展與合作｜小時光書店" },
      { property: "og:description", content: "與小時光共構一場策展。" },
      { property: "og:image", content: interiorImg },
    ],
  }),
  component: Curation,
});

function Curation() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Curation & Collaboration  ／  策展與合作"
        title="與我們，共構一場策展"
        intro="從一場書展、一個展覽，到一座生活節，我們以策展為方法，協助品牌與機構說出有層次的故事。"
      />

      <section className="container-editorial pb-24">
        <p className="eyebrow">What We Do  ／  合作類型</p>
        <div className="mt-10 grid gap-px bg-border border border-border md:grid-cols-2 lg:grid-cols-3">
          {collaborations.map((c) => (
            <div key={c.title} className="bg-background p-8">
              <h3 className="display text-xl">{c.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{c.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container-editorial pb-24">
        <p className="eyebrow">Selected Cases  ／  合作案例</p>
        <div className="mt-10 grid gap-10 md:grid-cols-3">
          {cases.map((c) => (
            <article key={c.title}>
              <div className="aspect-[4/5] overflow-hidden bg-muted">
                <img src={interiorImg} alt={c.title} loading="lazy" className="h-full w-full object-cover" />
              </div>
              <h3 className="font-serif text-xl mt-5">{c.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{c.line}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 grid lg:grid-cols-2 gap-12">
          <div>
            <p className="eyebrow">Get in Touch  ／  聯繫我們</p>
            <h2 className="display mt-5 text-4xl">先寫一封信，<br/>慢慢地談。</h2>
            <p className="mt-6 text-base leading-relaxed text-foreground/75 max-w-md">
              如果你有一個想法、一個品牌、一個空間，期待透過策展讓它被看見，歡迎來信。
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

export function CurationForm() {
  return (
    <form
      action={`mailto:${CONTACT_EMAIL}`}
      method="post"
      encType="text/plain"
      className="grid gap-5 text-sm"
    >
      <Field label="姓名" name="name" />
      <Field label="單位" name="org" />
      <Field label="合作類型" name="type" />
      <div className="grid grid-cols-2 gap-5">
        <Field label="預算" name="budget" />
        <Field label="檔期" name="schedule" />
      </div>
      <Field label="Email" name="email" type="email" />
      <div>
        <label className="eyebrow">需求概述</label>
        <textarea
          name="message"
          rows={5}
          className="mt-2 w-full border border-input bg-background px-4 py-3 text-sm focus:border-foreground focus:outline-none"
        />
      </div>
      <button type="submit" className="mt-2 self-start border border-foreground px-6 py-3 text-xs tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors">
        送出洽詢
      </button>
    </form>
  );
}

function Field({ label, name, type = "text" }: { label: string; name: string; type?: string }) {
  return (
    <div>
      <label className="eyebrow" htmlFor={name}>{label}</label>
      <input
        id={name}
        name={name}
        type={type}
        className="mt-2 w-full border border-input bg-background px-4 py-3 text-sm focus:border-foreground focus:outline-none"
      />
    </div>
  );
}
