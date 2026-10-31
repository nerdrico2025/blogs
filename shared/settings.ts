/**
 * Configurações editáveis de cada blog (/data/settings.json), por cima do sites/<nome>/site.config.ts.
 * Campo vazio ou ausente = vale o que está no site.config.ts. Lido pelo build e pela API.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Category, ImageRef, SiteConfig } from "../src/lib/config-schema.ts";
import { localDataDir, siteDir } from "../src/lib/site-id.ts";

export const AD_POSITIONS = ["header", "beforeContent", "inContent", "afterContent", "sidebarTop", "sidebarBottom", "footer", "mobileSticky"] as const;
export type AdPosition = (typeof AD_POSITIONS)[number];
export type PageType = "home" | "article" | "category";

export interface AdSlot {
  enabled: boolean;
  code: string;
  devices: "both" | "desktop" | "mobile";
  pageTypes: PageType[];
  /** Ids de categoria; vazio = todas. Não se aplica à home. */
  includeCategories: number[];
  excludeCategories: number[];
  /** Altura reservada (px), para o anúncio não empurrar o texto ao carregar. */
  minHeight: number;
  /** Só em inContent. */
  afterParagraph?: number;
  /** 0 = não repete. */
  repeatEvery?: number;
  maxBlocks?: number;
}

export interface AdsConfig {
  headScript: string;
  slots: Partial<Record<AdPosition, AdSlot>>;
}

export interface TrackingConfig {
  gtmId: string;
  headCode: string;
  bodyCode: string;
}

export interface Settings {
  /** Marca o fim do assistente de primeiro acesso. */
  configured?: boolean;
  lang?: string;
  tagline?: string;
  description?: string;
  brand?: {
    name?: string;
    logo?: { src: string; width: number; height: number };
    favicon?: string;
    /** Ícones gerados no envio do favicon; `version` é o hash do arquivo, usado no ?v= das URLs. */
    faviconSet?: { version: string; svg: boolean };
    /** Imagens geradas pelo assistente. */
    defaultImage?: string;
    organizationLogo?: string;
    avatar?: string;
    colors?: { primary?: string; highlight?: string; callout?: string };
  };
  author?: { name?: string; bio?: string };
  tracking?: Partial<TrackingConfig>;
  ads?: { headScript?: string; adsTxt?: string; slots?: Partial<Record<AdPosition, AdSlot>> };
  categories?: Category[];
  nextCategoryId?: number;
}

export function settingsFile(): string {
  return path.resolve(process.env.SETTINGS_FILE ?? path.join(localDataDir(), "settings.json"));
}

export function assetsRoot(): string {
  return path.resolve(process.env.ASSETS_DIR ?? path.join(localDataDir(), "assets"));
}

/** O arquivo do volume; na falta dele, o inicial gerado por `new-site` (sites/<nome>/settings.json). */
export function readSettings(file = settingsFile()): Settings {
  for (const f of [file, path.join(siteDir(), "settings.json")]) {
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as Settings;
  }
  return {};
}

const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const rgbToHex = (rgb: number[]) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

export const isHex = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);

/** amount > 0 clareia; < 0 escurece. */
export function shade(hex: string, amount: number): string {
  return rgbToHex(hexToRgb(hex).map((v) => (amount > 0 ? v + (255 - v) * amount : v * (1 + amount))));
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Escurece a cor até o texto branco (e ela sobre fundo branco) ficar legível. */
export function ensureReadable(hex: string, min = 4.5): string {
  let c = hex;
  for (let i = 0; i < 40 && contrastRatio(c, "#ffffff") < min; i++) c = shade(c, -0.05);
  return c;
}

/** Avisos em linguagem simples; não impedem salvar. */
export function contrastWarnings(colors: { primary?: string; highlight?: string; callout?: string }): string[] {
  const out: string[] = [];
  const check = (value: string | undefined, label: string, use: string) => {
    if (value && isHex(value) && contrastRatio(value, "#ffffff") < 4.5) {
      out.push(`${label}: tom claro (contraste ${contrastRatio(value, "#ffffff").toFixed(1)}:1 com o branco; o mínimo é 4,5:1). ${use} Se preferir manter a cor exata, tente um tom mais escuro.`);
    }
  };
  check(colors.primary, "Cor principal", "Os links sairão num tom mais escuro e o texto dos botões pode ficar preto.");
  check(colors.highlight, "Cor de destaque", "As etiquetas e os títulos pequenos sairão num tom mais escuro.");
  check(colors.callout, "Cor do cartão de chamada", "O texto do cartão pode ficar preto.");
  return out;
}

/** Texto branco ou preto, o de maior contraste no pior dos fundos (o cartão tem gradiente de dois tons). */
export function textOn(...backgrounds: string[]): "#ffffff" | "#000000" {
  const worst = (text: string) => Math.min(...backgrounds.map((bg) => contrastRatio(text, bg)));
  return worst("#ffffff") >= worst("#000000") ? "#ffffff" : "#000000";
}

/**
 * Variáveis CSS das três cores da marca. Mapa de uso:
 * principal: links, botões, foco, menu ativo, sumário e "Aceitar" dos cookies;
 * destaque: etiquetas, autor, títulos pequenos e "Leia também";
 * cartão: cartão da lateral, CTA do meio do texto e clube.
 * -texto: texto sobre esse fundo. -legivel: a cor como texto sobre fundo claro (cor clara é escurecida até 4,5:1).
 * Espelhada na prévia do painel (api/admin-ui/color.js); um teste garante que as duas contas batem.
 */
export function brandVars(site: Pick<SiteConfig, "theme">): string {
  const c = site.theme.colors;
  const primary = c.accent;
  const highlight = site.theme.highlight ?? c.accent;
  const readable = ensureReadable(primary);
  const vars: Record<string, string> = {
    "cor-principal": primary,
    "cor-principal-escura": c.accentHover,
    "cor-principal-clara": shade(primary, 0.92),
    "cor-principal-borda": shade(primary, 0.75),
    "cor-principal-texto": textOn(primary),
    "cor-principal-escura-texto": textOn(c.accentHover),
    "cor-principal-legivel": readable,
    "cor-principal-legivel-hover": shade(readable, -0.2),
    "cor-destaque": highlight,
    "cor-destaque-texto": textOn(highlight),
    "cor-destaque-legivel": ensureReadable(highlight),
    "cor-cartao": c.calloutFrom,
    "cor-cartao-fim": c.calloutTo,
    "cor-cartao-texto": textOn(c.calloutFrom, c.calloutTo),
  };
  return Object.entries(vars).map(([k, v]) => `--${k}:${v}`).join(";");
}

function replaceDeep<T>(value: T, from: string, to: string): T {
  if (typeof value === "string") return value.replaceAll(from, to) as T;
  if (Array.isArray(value)) return value.map((v) => replaceDeep(v, from, to)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceDeep(v, from, to)])) as T;
  }
  return value;
}

const CATEGORY_HREF = (slug: string) => `/category/${slug}/`;

/** Menu: mantém os outros itens; rótulo da categoria só muda se o nome dela mudou. */
function buildNav(base: SiteConfig, categories: Category[]): SiteConfig["nav"] {
  const baseById = new Map(base.categories.map((c) => [c.id, c]));
  const used = new Set<string>();
  const items = categories.map((c) => {
    const old = baseById.get(c.id);
    const item = old && base.nav.find((n) => n.href === CATEGORY_HREF(old.slug));
    if (item) used.add(item.href);
    return { label: item && old!.name === c.name ? item.label : c.name, href: CATEGORY_HREF(c.slug) };
  });
  return [...items, ...base.nav.filter((n) => !used.has(n.href) && !n.href.startsWith("/category/"))];
}

const image = (src: string, ref: ImageRef): ImageRef => ({ ...ref, src });

export function applySettings(base: SiteConfig, s: Settings): SiteConfig {
  const name = s.brand?.name?.trim();
  const out: SiteConfig = structuredClone(name && name !== base.name ? replaceDeep(base, base.name, name) : base);
  // O domínio não passa pela troca de nome
  out.url = base.url;
  if (name) out.name = name;
  if (s.lang?.trim()) {
    out.lang = s.lang.trim();
    out.locale = out.lang.replace("-", "_");
  }
  if (s.tagline?.trim()) out.tagline = s.tagline.trim();
  if (s.description?.trim()) out.description = s.description.trim();

  const b = s.brand;
  if (b?.logo?.src) out.logo = { ...b.logo, alt: out.name };
  if (b?.favicon) out.favicon = b.favicon;
  if (b?.faviconSet) out.faviconSet = b.faviconSet;
  if (b?.defaultImage) out.seo.defaultImage = image(b.defaultImage, { ...out.seo.defaultImage, alt: out.name });
  if (b?.organizationLogo) out.seo.organizationLogo = image(b.organizationLogo, { ...out.seo.organizationLogo, alt: out.name });

  const colors = b?.colors;
  const c = out.theme.colors;
  if (isHex(colors?.primary)) {
    c.accent = colors.primary;
    c.accentHover = shade(colors.primary, -0.2);
  }
  if (isHex(colors?.highlight)) out.theme.highlight = colors.highlight;
  if (isHex(colors?.callout)) {
    c.calloutFrom = colors.callout;
    c.calloutTo = shade(colors.callout, 0.15);
  }

  const author = out.authors[out.defaultAuthor]!;
  if (s.author?.name?.trim()) author.name = s.author.name.trim();
  if (s.author?.bio?.trim()) author.bio = s.author.bio.trim();
  if (b?.avatar) author.avatar = b.avatar;

  if (s.categories?.length) {
    out.categories = s.categories;
    out.nav = replaceDeep(buildNav(base, s.categories), base.name, out.name);
  }

  if (s.tracking) out.tracking = { gtmId: s.tracking.gtmId ?? "", headCode: s.tracking.headCode ?? "", bodyCode: s.tracking.bodyCode ?? "" };
  if (s.ads) {
    out.ads = { headScript: s.ads.headScript ?? "", slots: s.ads.slots ?? {} };
    if (s.ads.adsTxt?.trim()) out.adsTxt = s.ads.adsTxt.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  return out;
}

/** Categoria pelo slug atual ou por um slug antigo (posts gravados antes de renomear). */
export function findCategory(categories: Category[], slug: string): Category | undefined {
  return categories.find((c) => c.slug === slug) ?? categories.find((c) => c.aliases?.includes(slug));
}
