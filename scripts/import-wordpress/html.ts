/**
 * Limpeza do HTML vindo do WordPress e reescrita de imagens e links.
 *
 * Duas etapas, para dar para baixar as imagens entre elas:
 *   1. prepareHtml: tira comentários do Gutenberg, shortcodes, classes, estilos e atributos do WP,
 *      troca vídeos do YouTube por um link e lista as imagens (com o alt preservado ou gerado).
 *   2. finishHtml: troca o endereço de cada imagem pelo novo (ou remove a que não baixou) e
 *      devolve o HTML. É esse HTML que vai para o POST /posts, que ainda passa pela allowlist
 *      e pela conversão para Markdown do blog (api/html-to-md.ts).
 */
import type { Element, ElementContent, Root, RootContent } from "hast";
import { toHtml } from "hast-util-to-html";
import { toString } from "hast-util-to-string";
import rehypeParse from "rehype-parse";
import { unified } from "unified";
import { visit, SKIP } from "unist-util-visit";

const parser = unified().use(rehypeParse, { fragment: true });

/** Texto puro de um trecho HTML, com as entidades resolvidas (&#8211; → –). */
export function htmlText(html: string): string {
  return toString(parser.parse(html)).replace(/\s+/g, " ").trim();
}

/** Shortcodes que sempre somem, mesmo sem atributos nem fechamento. */
const KNOWN_SHORTCODES =
  /^(caption|wp_caption|gallery|embed|video|audio|playlist|contact-form-7|contact-form|wpforms|ninja_form|gravityform|toc|ez-toc|rank_math_[a-z_]+|yoast[a-z_-]*|vc_[a-z_]+|et_pb_[a-z_]+|fusion_[a-z_]+|elementor-template|su_[a-z_]+|button|row|column|col|one_half|one_third|two_third|one_fourth|tabs?|accordion|toggle|divider|spacer|adsense|ads?|ad_[a-z_]+|pretty_?link|shortcode)$/i;

/**
 * Remove shortcodes e mantém o texto entre a abertura e o fechamento ([caption]<img> legenda[/caption]).
 * Para não apagar texto como "[1]" ou "[sic]", só sai o que é shortcode conhecido, tem atributos
 * (nome="valor") ou tem fechamento [/nome] no mesmo texto.
 */
export function stripShortcodes(html: string): { html: string; removed: string[] } {
  const closed = new Set([...html.matchAll(/\[\/([a-z][\w-]*)\]/gi)].map((m) => m[1]!.toLowerCase()));
  const removed = new Set<string>();
  const out = html.replace(/\[(\/?)([a-z][\w-]*)((?:\s+[^\]]*)?)\/?\]/gi, (all, close: string, name: string, attrs: string) => {
    const n = name.toLowerCase();
    if (close || closed.has(n) || KNOWN_SHORTCODES.test(n) || /=\s*["'\w]/.test(attrs)) {
      removed.add(n);
      return "";
    }
    return all;
  });
  return { html: out, removed: [...removed] };
}

/** Converte texto com quebras de linha em parágrafos (o post_content cru do XML não tem <p>). */
export function autop(text: string): string {
  if (/<p[\s>]/i.test(text)) return text;
  const BLOCK = /^<(h[1-6]|ul|ol|li|blockquote|table|figure|div|pre|hr|img|iframe|p|section)[\s>/]/i;
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => (BLOCK.test(chunk) ? chunk : `<p>${chunk.replace(/\n/g, "<br>\n")}</p>`))
    .join("\n");
}

export interface ImageRef {
  /** URL absoluta encontrada no HTML. */
  url: string;
  /** Candidatas a baixar, na ordem: o original (sem -300x200) e depois a que estava no HTML. */
  candidates: string[];
  alt: string;
  altGenerated: boolean;
}

export interface PrepareOptions {
  /** URL base do site de origem (para resolver caminhos relativos). */
  base: string;
  /** Domínios do site antigo (sem www). */
  oldHosts: Set<string>;
  postTitle: string;
  /** Caminho antigo (decodificado, com barra final) → caminho novo. */
  resolveLink: (path: string) => string | null;
  /** Link do domínio antigo que sai do texto (caminho decodificado, como está no link). */
  dropLink?: (path: string) => boolean;
  /** URL de áudio que substitui o link do domínio antigo (o arquivo é copiado para o blog). */
  replaceLink?: (path: string) => string | null;
}

export interface Prepared {
  tree: Root;
  images: ImageRef[];
  /** Áudios hospedados na origem e usados no post (URLs absolutas, sem repetir). */
  audios: string[];
  /** Áudios vindos de --drop-links com "=>": se a cópia falhar, o link sai em vez de apontar para outro site. */
  replacedAudios: string[];
  /** Blocos de sumário de plugin removidos e listas de âncoras sem marca de plugin (mantidas). */
  tocsRemoved: number;
  manualTocs: number;
  stats: { shortcodes: string[]; embedsRemoved: number; videosLinked: number; linksRewritten: number; linksUnresolved: string[] };
}

const KEEP_ATTRS: Record<string, string[]> = {
  a: ["href", "title"],
  img: ["src", "alt", "title"],
  th: ["align"],
  td: ["align"],
};
const DROP_TAGS = new Set(["script", "style", "noscript", "template", "form", "input", "button", "select", "textarea", "svg", "object", "embed"]);

const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");

/**
 * Marcas (id ou classe) do contêiner de sumário dos plugins: Easy Table of Contents, Rank Math, Yoast, Table of
 * Contents Plus, LuckyWP, SimpleTOC, Spectra, Kadence, Ultimate Blocks, Elementor e o bloco do Gutenberg.
 * O blog gera o próprio sumário. Sem uma destas marcas, nada sai: índice escrito à mão fica e vai para o relatório.
 */
const TOC_BLOCKS = new Set([
  "ez-toc-container", "ez-toc-widget-container", "rank-math-toc", "wp-block-rank-math-toc-block", "wp-block-yoast-seo-table-of-contents", "yoast-table-of-contents",
  "toc_container", "lwptoc", "simpletoc", "wp-block-simpletoc-toc", "wp-block-uagb-table-of-contents", "uagb-toc__wrap", "wp-block-kadence-tableofcontents",
  "kb-table-of-contents-wrap", "ub_table-of-contents", "wp-block-ub-table-of-contents-block", "elementor-widget-table-of-contents", "wp-block-table-of-contents",
]);
const isTocBlock = (el: Element) =>
  TOC_BLOCKS.has(String(el.properties.id ?? "")) || (Array.isArray(el.properties.className) && el.properties.className.some((c) => TOC_BLOCKS.has(String(c))));

/** Extensões de áudio copiadas da origem para o blog. */
export const AUDIO_FILE = /\.(mp3|m4a|ogg|oga|wav|aac|opus)$/i;

/** Chave da imagem que ignora protocolo e www (o mesmo arquivo aparece como http e https). */
export function imageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${hostOf(u)}${decodeURI(u.pathname)}`;
  } catch {
    return url;
  }
}

/** O WordPress gera foto-300x200.jpg, foto-scaled.jpg e foto-rotated.jpg; o original é foto.jpg. */
export function originalCandidates(url: string): string[] {
  const m = url.match(/^(.*\/wp-content\/uploads\/.*?)(-\d+x\d+|-scaled|-rotated|-e\d{10,})(\.[a-z0-9]+)(\?.*)?$/i);
  return m ? [m[1]! + m[3]!, url] : [url];
}

/** Alt que é só o nome do arquivo (P1010676, IMG_2034, DSC-1, image-3) não descreve nada. */
export function weakAlt(alt: string, url: string): boolean {
  const a = alt.trim();
  if (!a) return true;
  const file = decodeURIComponent(url.split("?")[0]!.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/-\d+x\d+$/, "");
  if (a.toLowerCase() === file.toLowerCase()) return true;
  return /^(img|dsc|dscn|dcim|p|pic|image|imagem|foto|photo|screenshot|captura|wp|whatsapp image)[\s_-]?[\d_-]*$/i.test(a) || /^[\d_\s-]+$/.test(a);
}

function youtubeId(src: string): string | null {
  const m = src.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1]! : null;
}

function absolute(url: string, base: string): URL | null {
  try {
    return new URL(url.trim(), base);
  } catch {
    return null;
  }
}

export function prepareHtml(rawHtml: string, opts: PrepareOptions): Prepared {
  const { html, removed } = stripShortcodes(autop(rawHtml));
  const tree = parser.parse(html) as Root;
  const stats: Prepared["stats"] = { shortcodes: removed, embedsRemoved: 0, videosLinked: 0, linksRewritten: 0, linksUnresolved: [] };
  const images: ImageRef[] = [];
  const seen = new Map<string, ImageRef>();
  const audios = new Map<string, string>();
  /** Parágrafos de onde saiu um link da lista --drop-links. */
  const dropped = new Set<Element>();
  const replaced = new Map<string, string>();
  const isOld = (u: URL) => opts.oldHosts.has(hostOf(u));

  // Sumário de plugin sai antes de tudo: os links dele não entram nas contagens
  let tocsRemoved = 0;
  visit(tree, "element", (node: Element, index, parent) => {
    if (!parent || index === undefined || !isTocBlock(node)) return;
    (parent.children as RootContent[]).splice(index, 1);
    tocsRemoved++;
    return [SKIP, index];
  });
  // Lista só com âncoras da própria página, sem marca de plugin: índice escrito à mão, que fica como está
  let manualTocs = 0;
  visit(tree, "element", (node: Element) => {
    if (node.tagName !== "ul" && node.tagName !== "ol") return;
    const hrefs: string[] = [];
    visit(node, "element", (a: Element) => {
      if (a.tagName === "a") hrefs.push(String(a.properties.href ?? ""));
    });
    const anchor = (h: string) => {
      if (h.startsWith("#")) return h.length > 1;
      const u = absolute(h, opts.base);
      return Boolean(u?.hash && isOld(u));
    };
    if (hrefs.length < 3 || !hrefs.every(anchor)) return;
    manualTocs++;
    return SKIP;
  });

  // Legenda de cada imagem dentro de <figure> (vira alt quando o alt é fraco)
  const captions = new Map<Element, string>();
  visit(tree, "element", (node: Element) => {
    if (node.tagName !== "figure") return;
    const cap = node.children.find((c): c is Element => c.type === "element" && c.tagName === "figcaption");
    if (!cap) return;
    visit(node, "element", (img: Element) => {
      if (img.tagName === "img") captions.set(img, toString(cap).replace(/\s+/g, " ").trim());
    });
  });

  visit(tree, (node, index, parent) => {
    if (node.type === "comment" || node.type === "doctype") {
      if (parent && index !== undefined) {
        parent.children.splice(index, 1);
        return [SKIP, index];
      }
      return;
    }
    if (node.type !== "element" || !parent || index === undefined) return;
    const el = node as Element;
    const replace = (...nodes: RootContent[]): [typeof SKIP, number] => {
      (parent.children as RootContent[]).splice(index, 1, ...nodes);
      return [SKIP, index];
    };

    if (DROP_TAGS.has(el.tagName)) return replace();

    if (el.tagName === "iframe") {
      const src = String(el.properties.src ?? el.properties.dataSrc ?? "");
      const id = youtubeId(src);
      if (!id) {
        stats.embedsRemoved++;
        return replace();
      }
      stats.videosLinked++;
      const label = String(el.properties.title ?? "").trim() || "Assista ao vídeo no YouTube";
      return replace({
        type: "element",
        tagName: "p",
        properties: {},
        children: [{ type: "element", tagName: "a", properties: { href: `https://www.youtube.com/watch?v=${id}` }, children: [{ type: "text", value: `Vídeo: ${label}` }] }],
      });
    }

    // Player de áudio da origem: o blog não aceita <audio>, então vira um link (tratado no ramo do <a>)
    if (el.tagName === "audio") {
      const source = el.children.find((c): c is Element => c.type === "element" && c.tagName === "source");
      const url = absolute(String(el.properties.src ?? source?.properties.src ?? ""), opts.base);
      if (url && isOld(url) && AUDIO_FILE.test(url.pathname)) {
        // Bloco de áudio do Gutenberg: <figure> sem imagem seria removida no finishHtml
        if (parent.type === "element" && parent.tagName === "figure") parent.tagName = "p";
        return replace({ type: "element", tagName: "a", properties: { href: url.href }, children: [{ type: "text", value: "Ouça o áudio" }] });
      }
    }

    if (el.tagName === "img") {
      // Lazy load de plugins: o endereço real fica em data-src / data-lazy-src
      const p = el.properties;
      const raw = [p.dataLazySrc, p.dataSrc, p.dataOrigFile, p.src].map((v) => (v === undefined ? "" : String(v))).find((v) => v && !v.startsWith("data:")) ?? "";
      const url = raw ? absolute(raw, opts.base) : null;
      if (!url || !/^https?:$/.test(url.protocol)) return replace();
      const alt = String(p.alt ?? "").replace(/\s+/g, " ").trim();
      const title = String(p.title ?? "").trim();
      const strong = !weakAlt(alt, url.href);
      const finalAlt = strong ? alt : captions.get(el) || (title && !weakAlt(title, url.href) ? title : "") || opts.postTitle;
      el.properties = { src: url.href, alt: finalAlt };
      const key = imageKey(url.href);
      if (!seen.has(key)) {
        const ref: ImageRef = { url: url.href, candidates: originalCandidates(url.href), alt: finalAlt, altGenerated: !strong };
        seen.set(key, ref);
        images.push(ref);
      }
      return;
    }

    if (el.tagName === "a") {
      const href = String(el.properties.href ?? "");
      const url = href && !href.startsWith("#") ? absolute(href, opts.base) : null;
      el.properties = href ? { href } : {};
      if (url && isOld(url) && /^https?:$/.test(url.protocol)) {
        if (opts.dropLink?.(decodeURI(url.pathname))) {
          if (parent.type === "element") dropped.add(parent);
          return replace();
        }
        const replacement = opts.replaceLink?.(decodeURI(url.pathname));
        if (replacement) {
          audios.set(imageKey(replacement), replacement);
          replaced.set(imageKey(replacement), replacement);
          el.properties.href = replacement;
          return;
        }
        // O áudio é copiado para o blog; finishHtml troca pelo endereço novo
        if (AUDIO_FILE.test(url.pathname)) {
          audios.set(imageKey(url.href), url.href);
          el.properties.href = url.href;
          return;
        }
        const onlyImage = el.children.every((c) => (c.type === "element" && c.tagName === "img") || (c.type === "text" && !c.value.trim()));
        if (url.pathname.includes("/wp-content/uploads/") && onlyImage) {
          // Link para a foto ampliada: sem sentido no blog novo
          return replace(...(el.children as RootContent[]));
        }
        const pathname = decodeURI(url.pathname);
        const target = opts.resolveLink(pathname.endsWith("/") || /\.[a-z0-9]+$/i.test(pathname) ? pathname : `${pathname}/`);
        if (target) {
          el.properties.href = target + url.hash;
          stats.linksRewritten++;
        } else {
          el.properties.href = url.pathname + url.search + url.hash;
          stats.linksUnresolved.push(pathname);
        }
      }
      return;
    }

    // Demais tags: só os atributos permitidos (sem class, style, id, data-*, width…)
    const keep = KEEP_ATTRS[el.tagName] ?? [];
    el.properties = Object.fromEntries(Object.entries(el.properties).filter(([k]) => keep.includes(k)));

    // <span> sem atributo não acrescenta nada
    if (el.tagName === "span" || el.tagName === "font" || el.tagName === "u") return replace(...(el.children as RootContent[]));
    return;
  });

  // Título com negrito em volta de tudo (<h2><strong>Dica</strong></h2>) vira só o título
  visit(tree, "element", (node: Element) => {
    if (!/^h[1-6]$/.test(node.tagName)) return;
    const meaningful = node.children.filter((c) => !(c.type === "text" && !c.value.trim()));
    if (meaningful.length === 1 && meaningful[0]!.type === "element" && ["strong", "b", "em"].includes(meaningful[0]!.tagName)) {
      node.children = (meaningful[0] as Element).children;
    }
  });

  // Título logo antes dos parágrafos que perderam o link: sem nada embaixo, ele sai junto
  const isHeading = (el: Element | undefined) => Boolean(el && /^h[1-6]$/.test(el.tagName));
  const orphanCandidates = new Set<Element>();
  let lastHeading: Element | undefined;
  for (const el of tree.children.filter((c): c is Element => c.type === "element")) {
    if (isHeading(el)) lastHeading = el;
    else if (!dropped.has(el)) lastHeading = undefined;
    else if (lastHeading) orphanCandidates.add(lastHeading);
  }

  // Parágrafos que ficaram vazios (sobra de shortcode ou &nbsp;)
  visit(tree, "element", (node: Element, index, parent) => {
    if (!parent || index === undefined || node.tagName !== "p") return;
    const hasImage = node.children.some((c) => c.type === "element" && c.tagName === "img");
    if (!hasImage && !toString(node).replace(/ /g, " ").trim()) {
      (parent.children as ElementContent[]).splice(index, 1);
      return [SKIP, index];
    }
    return;
  });

  for (const heading of orphanCandidates) {
    const siblings = tree.children.filter((c): c is Element => c.type === "element");
    const next = siblings[siblings.indexOf(heading) + 1];
    if (!next || isHeading(next)) tree.children.splice(tree.children.indexOf(heading), 1);
  }

  return { tree, images, audios: [...audios.values()], replacedAudios: [...replaced.values()], tocsRemoved, manualTocs, stats };
}

/**
 * Troca cada imagem pelo endereço novo (caminho /wp-content/uploads/… do blog, para o build achar
 * as variantes WebP) e remove as que não baixaram. Link de áudio vai para o endereço novo; se o áudio
 * não foi copiado, fica com o caminho antigo.
 */
export function finishHtml(prep: Prepared, newSrc: (url: string) => string | null, newAudio: (url: string) => string | null = () => null): string {
  const audioKeys = new Set(prep.audios.map(imageKey));
  const replacedKeys = new Set(prep.replacedAudios.map(imageKey));
  visit(prep.tree, "element", (node: Element, index, parent) => {
    if (node.tagName !== "a" || !audioKeys.has(imageKey(String(node.properties.href)))) return;
    const url = new URL(String(node.properties.href));
    const target = newAudio(url.href);
    if (!target && replacedKeys.has(imageKey(url.href)) && parent && index !== undefined) {
      (parent.children as ElementContent[]).splice(index, 1);
      return [SKIP, index];
    }
    node.properties.href = target ?? url.pathname;
    return;
  });
  visit(prep.tree, "element", (node: Element, index, parent) => {
    if (node.tagName !== "img" || !parent || index === undefined) return;
    const target = newSrc(String(node.properties.src));
    if (target) {
      node.properties.src = target;
      return;
    }
    (parent.children as ElementContent[]).splice(index, 1);
    return [SKIP, index];
  });
  // Parágrafo ou figura que só tinha a imagem removida
  visit(prep.tree, "element", (node: Element, index, parent) => {
    if (!parent || index === undefined || !["p", "figure"].includes(node.tagName)) return;
    const hasImage = node.children.some((c) => c.type === "element" && (c.tagName === "img" || c.tagName === "figcaption"));
    if (node.tagName === "figure" ? !node.children.some((c) => c.type === "element" && c.tagName === "img") : !hasImage && !toString(node).trim()) {
      (parent.children as ElementContent[]).splice(index, 1);
      return [SKIP, index];
    }
    return;
  });
  return toHtml(prep.tree).replace(/\n{3,}/g, "\n\n").trim();
}

/** Excerpt automático do WP: tira o "[…]" e o "Leia mais". */
export function cleanExcerpt(html: string): string {
  return htmlText(html.replace(/<a[^>]*class="[^"]*more-link[^"]*"[\s\S]*?<\/a>/gi, ""))
    .replace(/\s*\[(?:…|&hellip;|\.\.\.)\]\s*$/, "…")
    .replace(/\s*(Leia mais|Continue lendo|Read more|Continue reading)\b.*$/i, "")
    .trim();
}
