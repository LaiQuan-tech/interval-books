import { Link } from "@tanstack/react-router";
import { CONTACT_EMAIL, SOCIAL, VISIT } from "@/data/site";

export function SiteFooter() {
  return (
    <footer className="mt-32 border-t border-border/60 bg-[oklch(0.96_0.014_82)]/60">
      <div className="container-editorial py-16 grid gap-12 md:grid-cols-4">
        <div className="md:col-span-2">
          <h3 className="font-serif text-2xl">小時光書店</h3>
          <p className="eyebrow mt-2 text-[0.6rem]">Hourlight Bookstore</p>
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground max-w-sm">
            以書展策展為核心，串連地方選物、陶藝作品、讀書會與身心靈活動，延伸至深度策旅與合作提案。
          </p>
        </div>

        <div className="text-sm leading-relaxed">
          <p className="eyebrow mb-4">來訪</p>
          <p>{VISIT.address}</p>
          <p className="text-muted-foreground mt-1">{VISIT.city}</p>
          <p className="mt-3">{VISIT.hours}</p>
          <p className="text-muted-foreground">{VISIT.closed}</p>
        </div>

        <div className="text-sm leading-relaxed">
          <p className="eyebrow mb-4">聯繫</p>
          <a href={`mailto:${CONTACT_EMAIL}`} className="hover-underline">{CONTACT_EMAIL}</a>
          <div className="mt-4 flex gap-4 text-muted-foreground">
            <a href={SOCIAL.instagram} target="_blank" rel="noreferrer" className="hover-underline">Instagram</a>
            <a href={SOCIAL.facebook} target="_blank" rel="noreferrer" className="hover-underline">Facebook</a>
            <a href={SOCIAL.line} target="_blank" rel="noreferrer" className="hover-underline">LINE</a>
          </div>
        </div>
      </div>

      <div className="border-t border-border/60">
        <div className="container-editorial flex flex-col md:flex-row gap-3 md:items-center md:justify-between py-6 text-xs text-muted-foreground">
          <p>© {new Date().getFullYear()} 小時光書店  Hourlight Bookstore</p>
          <Link to="/privacy" className="hover-underline">隱私權聲明</Link>
        </div>
      </div>
    </footer>
  );
}
