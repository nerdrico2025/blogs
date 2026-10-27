/**
 * Transformações do corpo dos posts:
 * - imagem sozinha num parágrafo → <figure> com <picture> (avif/webp, srcset, width/height) e legenda;
 * - tabelas dentro de um contêiner com rolagem horizontal;
 * - blockquote iniciado por [!DICA], [!ATENCAO] ou [!INFO] → caixa de destaque;
 * - seção "Perguntas frequentes" → bloco de FAQ, com os pares pergunta/resposta no frontmatter (FAQPage);
 * - links externos com rel="noopener";
 * - tempo de leitura no frontmatter.
 */
import type { Element, ElementContent, Root, RootContent } from "hast";
import GithubSlugger from "github-slugger";
import { h } from "hastscript";
import { toString } from "hast-util-to-string";
import { visit, SKIP } from "unist-util-visit";
import type { VFile } from "vfile";
import { readMediaMeta, srcset, variantUrl } from "../../shared/media.ts";

export interface FaqItem {
  question: string;
  answer: string;
}

interface Options {
  wordsPerMinute: number;
  /** Valor do atributo `sizes` das imagens do corpo. */
  sizes?: string;
}

const CALLOUTS: Record<string, { cls: string; label: string }> = {
  DICA: { cls: "tip", label: "Dica" },
  ATENCAO: { cls: "warn", label: "Atenção" },
  "ATENÇÃO": { cls: "warn", label: "Atenção" },
  INFO: { cls: "info", label: "Importante" },
};

const FAQ_TITLE = /^(perguntas frequentes|faq|dúvidas frequentes|duvidas frequentes)\b/i;

const isElement = (n: RootContent | ElementContent | undefined, tag?: string): n is Element =>
  !!n && n.type === "element" && (!tag || n.tagName === tag);

const isBlank = (n: ElementContent) => n.type === "text" && !n.value.trim();

function frontmatter(file: VFile): Record<string, unknown> {
  const data = file.data as { astro?: { frontmatter?: Record<string, unknown> } };
  data.astro ??= {};
  data.astro.frontmatter ??= {};
  return data.astro.frontmatter;
}

function pictureFor(img: Element, eager: boolean, sizes: string): Element {
  const src = String(img.properties.src ?? "");
  const alt = String(img.properties.alt ?? "");
  const meta = readMediaMeta(src);
  const attrs = {
    alt,
    loading: eager ? undefined : "lazy",
    fetchpriority: eager ? "high" : undefined,
    decoding: "async",
  };
  if (!meta) return h("img", { src, ...attrs });
  const fallbackWidth = meta.widths.find((w) => w >= 768) ?? meta.widths[meta.widths.length - 1]!;
  return h("picture", [
    h("source", { type: "image/avif", srcset: srcset(meta, "avif"), sizes }),
    h("img", {
      src: variantUrl(meta, fallbackWidth, "webp"),
      srcset: srcset(meta, "webp"),
      sizes,
      width: meta.width,
      height: meta.height,
      ...attrs,
    }),
  ]);
}

export function rehypeBlog(options: Options) {
  const sizes = options.sizes ?? "(max-width: 921px) calc(100vw - 32px), 760px";

  return (tree: Root, file: VFile) => {
    const fm = frontmatter(file);
    let eagerAvailable = !fm.cover;

    // Âncoras ASCII nos títulos (o Astro mantém ids já definidos)
    const slugger = new GithubSlugger();
    visit(tree, "element", (node) => {
      if (/^h[2-6]$/.test(node.tagName) && !node.properties.id) {
        node.properties.id = slugger.slug(toString(node).normalize("NFD").replace(/[̀-ͯ]/g, ""));
      }
    });

    // Imagens, tabelas, citações e links
    visit(tree, "element", (node, index, parent) => {
      if (!parent || index === undefined) return;

      if (node.tagName === "p") {
        const kids = node.children.filter((c) => !isBlank(c));
        const only = kids.length === 1 ? kids[0] : undefined;
        if (isElement(only, "img")) {
          const caption = only.properties.title ? String(only.properties.title) : "";
          const figure = h("figure", { className: ["post-figure"] }, [
            pictureFor(only, eagerAvailable, sizes),
            ...(caption ? [h("figcaption", caption)] : []),
          ]);
          eagerAvailable = false;
          parent.children[index] = figure;
          return SKIP;
        }
      }

      if (node.tagName === "img") {
        const pic = pictureFor(node, false, sizes);
        parent.children[index] = pic;
        return SKIP;
      }

      if (node.tagName === "table") {
        parent.children[index] = h("div", { className: ["table-wrap"], role: "region", tabIndex: 0, ariaLabel: "Tabela" }, [node]);
        return SKIP;
      }

      if (node.tagName === "blockquote") {
        const first = node.children.find((c) => isElement(c, "p")) as Element | undefined;
        const firstText = first?.children[0];
        if (first && firstText?.type === "text") {
          const m = firstText.value.match(/^\s*\[!([A-ZÇÃ]+)\]\s*/);
          const kind = m ? CALLOUTS[m[1]!] : undefined;
          if (m && kind) {
            firstText.value = firstText.value.slice(m[0].length);
            if (!firstText.value.trim()) first.children.shift();
            if (first.children.length === 0 || first.children.every(isBlank)) node.children.splice(node.children.indexOf(first), 1);
            parent.children[index] = h("aside", { className: ["callout", `callout-${kind.cls}`] }, [
              h("p", { className: ["callout-label"] }, kind.label),
              ...node.children,
            ]);
            return SKIP;
          }
        }
      }

      if (node.tagName === "a") {
        const href = String(node.properties.href ?? "");
        if (/^https?:\/\//.test(href)) node.properties.rel = ["noopener"];
      }
    });

    // FAQ: H2 "Perguntas frequentes" seguido de H3 (pergunta) + conteúdo (resposta)
    const faq: FaqItem[] = [];
    const start = tree.children.findIndex((n) => isElement(n, "h2") && FAQ_TITLE.test(toString(n).trim()));
    if (start >= 0) {
      let end = tree.children.findIndex((n, i) => i > start && isElement(n, "h2"));
      if (end < 0) end = tree.children.length;
      const section = tree.children.slice(start + 1, end);
      const items: Element[] = [];
      let current: { q: Element; a: RootContent[] } | null = null;
      const flush = () => {
        if (!current) return;
        const answerNodes = current.a.filter((n) => n.type === "element") as Element[];
        const answer = answerNodes.map((n) => toString(n).trim()).join(" ").trim();
        if (answer) {
          faq.push({ question: toString(current.q).trim(), answer });
          items.push(h("div", { className: ["faq-item"] }, [current.q, h("div", { className: ["faq-answer"] }, answerNodes)]));
        }
        current = null;
      };
      for (const n of section) {
        if (isElement(n, "h3")) {
          flush();
          current = { q: n, a: [] };
        } else if (current) current.a.push(n);
      }
      flush();
      if (faq.length > 0) {
        const heading = tree.children[start] as Element;
        tree.children.splice(start, end - start, h("section", { className: ["faq"] }, [heading, ...items]));
      }
    }
    fm.faq = faq;

    // Tempo de leitura
    const words = toString(tree).trim().split(/\s+/).filter(Boolean).length;
    fm.words = words;
    fm.readingTime = Math.max(1, Math.round(words / options.wordsPerMinute));
  };
}
