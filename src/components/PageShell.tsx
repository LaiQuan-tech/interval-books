import type { ReactNode } from "react";
import { SiteHeader } from "./SiteHeader";
import { SiteFooter } from "./SiteFooter";

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  intro,
}: {
  eyebrow: string;
  title: string;
  intro?: string;
}) {
  return (
    <section className="container-editorial pt-20 md:pt-28 pb-12 md:pb-16">
      <p className="eyebrow text-2xl">{eyebrow}</p>
      <h1 className="display mt-5 text-5xl md:text-7xl max-w-4xl">{title}</h1>
      {intro && (
        <p className="mt-8 max-w-2xl text-base md:text-lg leading-relaxed text-muted-foreground">
          {intro}
        </p>
      )}
      <div className="rule mt-10" />
    </section>
  );
}
