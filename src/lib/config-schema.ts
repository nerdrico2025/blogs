export interface Link {
  label: string;
  href: string;
}

export interface ImageRef {
  src: string;
  width: number;
  height: number;
  alt: string;
}

export interface Category {
  id: number;
  slug: string;
  name: string;
  description: string;
}

export interface Author {
  name: string;
  role?: string;
  bio: string;
  avatar: string;
  links?: Partial<Record<"youtube" | "instagram" | "x" | "facebook" | "linkedin" | "site", string>>;
}

export type ShareNetwork = "whatsapp" | "facebook" | "x" | "linkedin" | "telegram" | "copy";
export type SidebarBlock = "search" | "newsletter" | "youtube" | "tools" | "callout" | "latest" | "affiliate";

interface Toggle {
  enabled: boolean;
}

export interface SiteConfig {
  name: string;
  tagline: string;
  description: string;
  /** Domínio com protocolo, sem barra no fim. */
  url: string;
  lang: string;
  locale: string;
  timezone: string;
  logo: ImageRef;
  favicon: string;
  theme: {
    colors: Record<
      | "accent" | "accentHover" | "heading" | "text" | "muted" | "bg" | "card" | "border" | "soft" | "ink"
      | "youtube" | "calloutFrom" | "calloutTo" | "calloutButtonText" | "club" | "imagePlaceholder" | "cookieBg" | "cookieAccept",
      string
    >;
    fontFamily: string;
    layout: { container: number; sidebar: number; gap: number };
  };
  categories: Category[];
  authors: Record<string, Author>;
  defaultAuthor: string;
  contact: { email: string };
  legal: { owner: string; city: string };
  social: Author["links"];
  nav: Link[];
  ticker: Toggle & {
    ratesSource: "static" | "awesomeapi";
    /** `code` é a moeda (USD, EUR…) e `value` o texto de reserva. */
    rates: { label: string; code: string; value: string }[];
    clocks: { label: string; timezone: string }[];
  };
  home: { perPage: number; banner: Toggle & ImageRef & { href: string } };
  sidebar: {
    order: SidebarBlock[];
    search: Toggle & { kicker: string; title: string; placeholder: string };
    newsletter: Toggle & { title: string; text: string; button: Link; note: string };
    youtube: Toggle & {
      kicker: string;
      channelId: string;
      fallback: { title: string; url: string; thumbnail: string };
      button: string;
    };
    tools: Toggle & { icon: string; title: string; text: string; items: { icon: string; label: string }[]; button: Link };
    callout: Toggle & { icon: string; kicker: string; title: string; text: string; button: Link };
    latest: Toggle & { kicker: string; title: string; count: number; badge: string };
    affiliate: Toggle & ImageRef & { href: string; /** Versão 2x para telas de alta densidade (opcional). */ src2x?: string };
  };
  article: {
    affiliateNotice: Toggle & { text: string };
    toc: Toggle & { title: string; minHeadings: number };
    cta: Toggle & { beforeH2: number; label: string; title: string; text: string; button: Link };
    readMore: Toggle & { beforeH2: number; label: string };
    related: { count: number; kicker: string; title: string; linkLabel: string };
    authorBox: Toggle & {
      kicker: string;
      youtubeLabel: string;
      newsletterLabel: string;
      club: Toggle & { title: string; text: string; button: Link; note: string };
    };
    share: ShareNetwork[];
    wordsPerMinute: number;
  };
  footer: { text: string; links: Link[] };
  seo: {
    defaultImage: ImageRef;
    organizationLogo: ImageRef;
    twitterHandle: string;
  };
  cookies: Toggle & {
    text: string;
    policyHref: string;
    categories: Record<"analytics" | "ads", { label: string; description: string }>;
  };
  analytics: { gaId: string; adsenseClient: string };
  adsTxt: string[];
}

export function defineSiteConfig(config: SiteConfig): SiteConfig {
  if (config.url.endsWith("/")) throw new Error("site.config.ts: `url` não pode terminar com barra.");
  const ids = new Set<number>();
  const slugs = new Set<string>();
  for (const c of config.categories) {
    if (ids.has(c.id) || slugs.has(c.slug)) throw new Error(`site.config.ts: categoria duplicada (${c.id}/${c.slug}).`);
    ids.add(c.id);
    slugs.add(c.slug);
  }
  if (!config.authors[config.defaultAuthor]) throw new Error("site.config.ts: `defaultAuthor` não existe em `authors`.");
  return config;
}
