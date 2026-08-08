import { createContext, useContext, type ReactNode } from "react";
import { FALLBACK_SITE_CONTENT, type SiteContent } from "@/lib/cms";

/**
 * Carries the site-wide copy (UI strings, SITE_INFO, contact, social, map)
 * fetched by the root route loader down to SiteHeader / SiteFooter / pages.
 *
 * The value is produced on the server during SSR and dehydrated with the rest
 * of the loader data, so the shell renders with real content in the HTML.
 */
const SiteContentContext = createContext<SiteContent | null>(null);

export function SiteContentProvider({
  value,
  children,
}: {
  value: SiteContent;
  children: ReactNode;
}) {
  return <SiteContentContext.Provider value={value}>{children}</SiteContentContext.Provider>;
}

/** Never throws: falls back to the bundled copy when rendered outside a provider. */
export function useSiteContent(): SiteContent {
  return useContext(SiteContentContext) ?? FALLBACK_SITE_CONTENT;
}
