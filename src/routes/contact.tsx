import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { CONTACT_EMAIL, SOCIAL } from "@/data/site";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "聯絡我們｜小時光書店" },
      { name: "description", content: "Email、Instagram、LINE——選擇你最舒服的方式與我們聯繫。" },
      { property: "og:title", content: "聯絡我們｜小時光書店" },
      { property: "og:description", content: "與小時光保持聯繫。" },
    ],
  }),
  component: Contact,
});

function Contact() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Contact  ／  聯絡我們"
        title="寫一封信給小時光"
        intro="無論是合作邀請、媒體採訪、選品詢問，或只是想說聲哈囉，都歡迎透過以下方式聯繫我們。"
      />

      <section className="container-editorial pb-32 grid gap-16 lg:grid-cols-2">
        <div>
          <p className="eyebrow">Channels  ／  聯絡管道</p>
          <div className="mt-8 space-y-8 text-sm">
            <div>
              <p className="eyebrow text-[0.6rem]">Email</p>
              <a href={`mailto:${CONTACT_EMAIL}`} className="mt-2 inline-block font-serif text-2xl hover-underline">{CONTACT_EMAIL}</a>
            </div>
            <div>
              <p className="eyebrow text-[0.6rem]">Instagram</p>
              <a href={SOCIAL.instagram} target="_blank" rel="noreferrer" className="mt-2 inline-block font-serif text-xl hover-underline">@intervalbookstw</a>
            </div>
            <div>
              <p className="eyebrow text-[0.6rem]">Facebook  ／  LINE</p>
              <div className="mt-2 flex gap-5 text-base">
                <a href={SOCIAL.facebook} target="_blank" rel="noreferrer" className="hover-underline">Facebook</a>
                <a href={SOCIAL.line} target="_blank" rel="noreferrer" className="hover-underline">LINE 官方帳號</a>
              </div>
            </div>
          </div>
        </div>

        <div>
          <p className="eyebrow">Quick Message  ／  快速留言</p>
          <form action={`mailto:${CONTACT_EMAIL}`} method="post" encType="text/plain" className="mt-8 grid gap-5 text-sm">
            <Field label="姓名" name="name" />
            <Field label="Email" name="email" type="email" />
            <Field label="主旨" name="subject" />
            <div>
              <label className="eyebrow" htmlFor="message">訊息</label>
              <textarea id="message" name="message" rows={6} className="mt-2 w-full border border-input bg-background px-4 py-3 text-sm focus:border-foreground focus:outline-none" />
            </div>
            <button type="submit" className="mt-2 self-start border border-foreground px-6 py-3 text-xs tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors">
              送出訊息
            </button>
          </form>
        </div>
      </section>
    </PageShell>
  );
}

function Field({ label, name, type = "text" }: { label: string; name: string; type?: string }) {
  return (
    <div>
      <label className="eyebrow" htmlFor={name}>{label}</label>
      <input id={name} name={name} type={type} className="mt-2 w-full border border-input bg-background px-4 py-3 text-sm focus:border-foreground focus:outline-none" />
    </div>
  );
}
