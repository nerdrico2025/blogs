/**
 * HTML recebido do Wordbee → Markdown limpo.
 * O HTML não vem sanitizado: passa por uma allowlist (rehype-sanitize) antes da conversão.
 * Tudo que não está na lista (script, style, iframe, atributos on*, comentários do Gutenberg)
 * é descartado.
 */
import type { Element, Root } from "hast";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import rehypeSanitize, { type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const SCHEMA: SanitizeSchema = {
  tagNames: [
    "h2", "h3", "h4", "p", "br", "ul", "ol", "li", "strong", "b", "em", "i", "blockquote",
    "a", "table", "thead", "tbody", "tr", "th", "td", "img", "figure", "figcaption", "hr", "code", "pre",
    // Contêineres sem atributos: mantêm a separação entre blocos na conversão
    "div", "section", "article", "span",
  ],
  attributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    th: ["align"],
    td: ["align"],
  },
  protocols: {
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
  strip: ["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math"],
  allowComments: false,
  allowDoctypes: false,
  clobber: [],
};

/** <h1> vira <h2> (o título do post já é o H1); h5/h6 viram h4; <div>/<span> são desembrulhados. */
function normalizeTags() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName === "h1") node.tagName = "h2";
      if (node.tagName === "h5" || node.tagName === "h6") node.tagName = "h4";
    });
  };
}

/**
 * Depois da sanitização: imagens só com URL absoluta ou em /wp-content/uploads,
 * e links sem href válido viram texto simples.
 */
function cleanLinksAndImages() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (!parent || index === undefined) return;
      if (node.tagName === "img") {
        const src = String(node.properties.src ?? "");
        if (!/^https?:\/\//.test(src) && !src.startsWith("/wp-content/uploads/")) {
          parent.children.splice(index, 1);
          return index;
        }
      }
      if (node.tagName === "a" && !node.properties.href) {
        parent.children.splice(index, 1, ...node.children);
        return index;
      }
    });
  };
}

const processor = unified()
  .use(rehypeParse, { fragment: true })
  .use(normalizeTags)
  .use(rehypeSanitize, SCHEMA)
  .use(cleanLinksAndImages)
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*", fences: true, rule: "-" });

export async function htmlToMarkdown(html: string): Promise<string> {
  const file = await processor.process(html);
  return String(file).trim() + "\n";
}

/** Texto puro (para excerpt e descrição): sem tags, entidades básicas resolvidas, espaços colapsados. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;/g, "’")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,.;:!?-]+$/, "") + "…";
}
