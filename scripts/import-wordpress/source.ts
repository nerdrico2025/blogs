/**
 * Leitura do site WordPress de origem: REST API (/wp-json/wp/v2/posts?_embed, paginada) ou,
 * como alternativa, o arquivo XML de exportação (Ferramentas → Exportar → Posts).
 * As duas viram a mesma lista de SourcePost.
 */
import { readFile } from "node:fs/promises";
import { cleanExcerpt, htmlText } from "./html.ts";

export const USER_AGENT = "BlogsImportador/1.0 (+migracao-wordpress)";

export interface SourceCategory {
  slug: string;
  name: string;
  /** Caminho público antigo, ex.: /category/lugares/america/ */
  path: string;
}

export interface SourcePost {
  id: string;
  title: string;
  slug: string;
  /** URL antiga do post. */
  link: string;
  /** ISO, UTC, sem fuso (como o date_gmt do WP). */
  dateGmt: string;
  modifiedGmt?: string;
  categories: SourceCategory[];
  html: string;
  excerpt: string;
  featured?: { url: string; alt: string };
  seoTitle?: string;
  seoDescription?: string;
}

export interface SourceSite {
  name: string;
  url: string;
  categories: SourceCategory[];
  /** Todos os posts publicados (caminho antigo → slug), para reescrever links internos. */
  allLinks: Map<string, string>;
  posts: SourcePost[];
  /** Quantos posts publicados existem na origem (antes do --limit). */
  total: number;
}

export async function fetchWithRetry(url: string, init: RequestInit = {}, timeoutMs = 30_000, tries = 3): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500 && i < tries - 1) {
        last = new Error(`HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function getJson<T>(url: string): Promise<{ data: T; headers: Headers }> {
  const res = await fetchWithRetry(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  try {
    return { data: JSON.parse(body) as T, headers: res.headers };
  } catch {
    throw new Error(`GET ${url} não devolveu JSON (a REST API está bloqueada?)`);
  }
}

export const pathOf = (link: string): string => {
  try {
    const p = decodeURI(new URL(link).pathname);
    return p.endsWith("/") ? p : `${p}/`;
  } catch {
    return link;
  }
};

/** Tira o " - Nome do Site" que Yoast e Rank Math põem no fim do <title>. */
export function stripSiteName(title: string, siteName: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (!siteName) return t;
  const esc = siteName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return t.replace(new RegExp(`\\s*[-|–—·:»•]\\s*${esc}\\s*$`, "i"), "").replace(new RegExp(`^${esc}\\s*[-|–—·:»•]\\s*`, "i"), "").trim();
}

/** Variáveis de título do Yoast (%%title%%) e do Rank Math (%title%) no XML. */
export function expandSeoVars(text: string, vars: { title: string; siteName: string; excerpt: string }): string {
  return text
    .replace(/%%?title%%?/gi, vars.title)
    .replace(/%%?sitename%%?/gi, vars.siteName)
    .replace(/%%?sep%%?/gi, "-")
    .replace(/%%?(excerpt|seo_description)%%?/gi, vars.excerpt)
    .replace(/%%?[a-z_]+%%?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/(\s*-\s*)+$/, "")
    .trim();
}

/** Meta title e description da página publicada, quando a REST API não traz os do Rank Math/Yoast. */
async function seoFromPage(link: string): Promise<{ title?: string; description?: string }> {
  const res = await fetchWithRetry(link, {}, 20_000, 2);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const head = (await res.text()).split(/<\/head>/i)[0] ?? "";
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const tag = head.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0];
  const description = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return { title: title ? htmlText(title) : undefined, description: description ? htmlText(description) : undefined };
}

interface WpPost {
  id: number;
  date_gmt: string;
  modified_gmt: string;
  slug: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  categories: number[];
  yoast_head_json?: { title?: string; description?: string };
  _embedded?: { "wp:featuredmedia"?: { source_url?: string; alt_text?: string; code?: string }[] };
}

export async function readRest(from: string, opts: { limit?: number; slugs?: string[]; onWarn: (msg: string) => void }): Promise<SourceSite> {
  const base = from.replace(/\/+$/, "");
  const api = `${base}/wp-json/wp/v2`;
  const { data: root } = await getJson<{ name?: string; url?: string }>(`${base}/wp-json/`);
  const siteName = htmlText(root.name ?? "");

  const categories = new Map<number, SourceCategory>();
  for (let page = 1; ; page++) {
    const { data, headers } = await getJson<{ id: number; slug: string; name: string; link: string }[]>(`${api}/categories?per_page=100&page=${page}`);
    for (const c of data) categories.set(c.id, { slug: c.slug, name: htmlText(c.name), path: pathOf(c.link) });
    if (page >= Number(headers.get("x-wp-totalpages") ?? 1)) break;
  }

  // Mapa de links de todos os posts publicados (leve: só slug e link)
  const allLinks = new Map<string, string>();
  let total = 0;
  for (let page = 1; ; page++) {
    const { data, headers } = await getJson<{ slug: string; link: string }[]>(`${api}/posts?per_page=100&page=${page}&_fields=slug,link`);
    for (const p of data) allLinks.set(pathOf(p.link), p.slug);
    total = Number(headers.get("x-wp-total") ?? allLinks.size);
    if (page >= Number(headers.get("x-wp-totalpages") ?? 1)) break;
  }

  const posts: SourcePost[] = [];
  const perPage = Math.min(100, opts.limit ?? 100);
  for (let page = 1; ; page++) {
    const only = opts.slugs?.length ? `&slug=${opts.slugs.map(encodeURIComponent).join(",")}` : "";
    const { data, headers } = await getJson<WpPost[]>(`${api}/posts?_embed=wp:featuredmedia&per_page=${perPage}&page=${page}&orderby=date&order=desc${only}`);
    for (const p of data) {
      if (opts.limit !== undefined && posts.length >= opts.limit) break;
      const title = htmlText(p.title.rendered);
      const media = p._embedded?.["wp:featuredmedia"]?.[0];
      let seoTitle = p.yoast_head_json?.title;
      let seoDescription = p.yoast_head_json?.description;
      if (!p.yoast_head_json) {
        try {
          ({ title: seoTitle, description: seoDescription } = await seoFromPage(p.link));
        } catch (err) {
          opts.onWarn(`${p.slug}: não deu para ler o meta title/description da página (${(err as Error).message})`);
        }
      }
      posts.push({
        id: String(p.id),
        title,
        slug: decodeURIComponent(p.slug),
        link: p.link,
        dateGmt: p.date_gmt,
        modifiedGmt: p.modified_gmt,
        categories: p.categories.flatMap((id) => categories.get(id) ?? []),
        html: p.content.rendered,
        excerpt: cleanExcerpt(p.excerpt.rendered),
        ...(media?.source_url && !media.code ? { featured: { url: media.source_url, alt: (media.alt_text ?? "").trim() } } : {}),
        ...(seoTitle ? { seoTitle: stripSiteName(seoTitle, siteName) } : {}),
        ...(seoDescription ? { seoDescription } : {}),
      });
    }
    if ((opts.limit !== undefined && posts.length >= opts.limit) || page >= Number(headers.get("x-wp-totalpages") ?? 1)) break;
  }
  return { name: siteName, url: base, categories: [...categories.values()], allLinks, posts, total };
}

// ---------------------------------------------------------------- XML (WXR)

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** Conteúdo de um nó: CDATA (uma ou várias seções) ou texto com entidades XML. */
function nodeText(raw: string | undefined): string {
  if (raw === undefined) return "";
  const cdata = [...raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)];
  return cdata.length ? cdata.map((m) => m[1]).join("") : decodeXml(raw.trim());
}

function tag(xml: string, name: string): string | undefined {
  const esc = name.replace(/[:.]/g, "\\$&");
  return xml.match(new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`))?.[1];
}

function postmeta(item: string): Map<string, string> {
  const meta = new Map<string, string>();
  for (const m of item.matchAll(/<wp:postmeta>([\s\S]*?)<\/wp:postmeta>/g)) {
    meta.set(nodeText(tag(m[1]!, "wp:meta_key")), nodeText(tag(m[1]!, "wp:meta_value")));
  }
  return meta;
}

const gmtIso = (s: string) => (s && !s.startsWith("0000") ? s.trim().replace(" ", "T") : "");

/**
 * Limpeza de uma página importada como post: tira o título repetido no começo do texto (com ou sem um
 * "[artigo]" na frente), os "títulos" que são só um endereço (rodapé de e-book: site, YouTube, Instagram)
 * e o parágrafo com convite de grupo do WhatsApp.
 */
export function cleanPageHtml(html: string, title: string): string {
  const plain = (h: string) => htmlText(h).replace(/^\[[a-z]+\]\s*/i, "").replace(/\s+/g, " ").trim().toLowerCase();
  let out = html;
  const first = out.match(/^\s*<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (first && plain(first[1]!) === plain(title)) out = out.slice(first[0].length);
  return out
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (m, inner: string) => (/^https?:\/\/\S+$/i.test(htmlText(inner).trim()) ? "" : m))
    .replace(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?chat\.whatsapp\.com(?:(?!<\/p>)[\s\S])*?<\/p>/gi, "");
}

/**
 * Páginas do WordPress escolhidas pelo slug (--include-pages), no formato de post. Não têm categoria:
 * o mapeamento precisa de uma regra "post:<slug> => <categoria>" para cada uma.
 */
export async function readPages(from: string, slugs: string[], onWarn: (msg: string) => void): Promise<SourcePost[]> {
  const api = `${from.replace(/\/+$/, "")}/wp-json/wp/v2`;
  const out: SourcePost[] = [];
  for (const wanted of slugs) {
    const { data } = await getJson<(WpPost & { status?: string })[]>(`${api}/pages?slug=${encodeURIComponent(wanted)}&_embed=wp:featuredmedia`);
    const p = data[0];
    if (!p) {
      onWarn(`--include-pages: a página "${wanted}" não existe na origem`);
      continue;
    }
    const title = htmlText(p.title.rendered);
    const media = p._embedded?.["wp:featuredmedia"]?.[0];
    out.push({
      id: `page-${p.id}`,
      title,
      slug: decodeURIComponent(p.slug),
      link: p.link,
      dateGmt: p.date_gmt,
      modifiedGmt: p.modified_gmt,
      categories: [],
      html: cleanPageHtml(p.content.rendered, title),
      excerpt: cleanExcerpt(p.excerpt?.rendered ?? ""),
      ...(media?.source_url && !media.code ? { featured: { url: media.source_url, alt: (media.alt_text ?? "").trim() } } : {}),
      ...(p.yoast_head_json?.title ? { seoTitle: p.yoast_head_json.title } : {}),
      ...(p.yoast_head_json?.description ? { seoDescription: p.yoast_head_json.description } : {}),
    });
  }
  return out;
}

export async function readXml(file: string, opts: { limit?: number; slugs?: string[]; base?: string }): Promise<SourceSite> {
  const xml = await readFile(file, "utf8");
  const channel = xml.split(/<item>/)[0]!;
  const siteName = nodeText(tag(channel, "title"));
  const url = (opts.base || nodeText(tag(channel, "wp:base_blog_url")) || nodeText(tag(channel, "link"))).replace(/\/+$/, "");

  // Categorias do canal (com o pai, para montar o caminho /category/pai/filho/)
  const raw = new Map<string, { name: string; parent: string }>();
  for (const m of channel.matchAll(/<wp:category>([\s\S]*?)<\/wp:category>/g)) {
    raw.set(nodeText(tag(m[1]!, "wp:category_nicename")), { name: nodeText(tag(m[1]!, "wp:cat_name")), parent: nodeText(tag(m[1]!, "wp:category_parent")) });
  }
  const catPath = (slug: string): string => {
    const chain: string[] = [];
    for (let s: string | undefined = slug; s && !chain.includes(s); s = raw.get(s)?.parent || undefined) chain.unshift(s);
    return `/category/${chain.join("/")}/`;
  };
  const categories = [...raw].map(([slug, c]) => ({ slug, name: c.name, path: catPath(slug) }));

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]!);
  const attachments = new Map<string, { url: string; alt: string }>();
  for (const item of items) {
    if (nodeText(tag(item, "wp:post_type")) !== "attachment") continue;
    attachments.set(nodeText(tag(item, "wp:post_id")), { url: nodeText(tag(item, "wp:attachment_url")), alt: postmeta(item).get("_wp_attachment_image_alt") ?? "" });
  }

  const all: SourcePost[] = [];
  for (const item of items) {
    if (nodeText(tag(item, "wp:post_type")) !== "post" || nodeText(tag(item, "wp:status")) !== "publish") continue;
    const meta = postmeta(item);
    const title = nodeText(tag(item, "title"));
    const excerpt = htmlText(nodeText(tag(item, "excerpt:encoded")));
    const vars = { title, siteName, excerpt };
    const seoTitleRaw = meta.get("_yoast_wpseo_title") || meta.get("rank_math_title") || "";
    const seoDescRaw = meta.get("_yoast_wpseo_metadesc") || meta.get("rank_math_description") || "";
    const seoTitle = seoTitleRaw ? stripSiteName(expandSeoVars(seoTitleRaw, vars), siteName) : "";
    const seoDescription = seoDescRaw ? expandSeoVars(seoDescRaw, vars) : "";
    const thumb = attachments.get(meta.get("_thumbnail_id") ?? "");
    const cats = [...item.matchAll(/<category domain="category" nicename="([^"]+)">([\s\S]*?)<\/category>/g)].map((m) => {
      const slug = decodeURIComponent(m[1]!);
      return { slug, name: nodeText(m[2]), path: catPath(slug) };
    });
    all.push({
      id: nodeText(tag(item, "wp:post_id")),
      title,
      slug: decodeURIComponent(nodeText(tag(item, "wp:post_name"))),
      link: nodeText(tag(item, "link")),
      dateGmt: gmtIso(nodeText(tag(item, "wp:post_date_gmt"))) || gmtIso(nodeText(tag(item, "wp:post_date"))),
      modifiedGmt: gmtIso(nodeText(tag(item, "wp:post_modified_gmt"))) || undefined,
      categories: cats,
      html: nodeText(tag(item, "content:encoded")),
      excerpt,
      ...(thumb?.url ? { featured: thumb } : {}),
      ...(seoTitle ? { seoTitle } : {}),
      ...(seoDescription ? { seoDescription } : {}),
    });
  }
  all.sort((a, b) => b.dateGmt.localeCompare(a.dateGmt));
  const allLinks = new Map(all.map((p) => [pathOf(p.link), p.slug]));
  const chosen = opts.slugs?.length ? all.filter((p) => opts.slugs!.includes(p.slug)) : all;
  const posts = opts.limit === undefined ? chosen : chosen.slice(0, opts.limit);
  return { name: siteName, url, categories, allLinks, posts, total: all.length };
}
