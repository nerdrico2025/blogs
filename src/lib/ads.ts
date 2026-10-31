/**
 * Posições de anúncio. O código fica guardado num atributo (inerte) e só é ativado no navegador
 * depois do consentimento (CookieConsent.astro). Tudo é decidido no build.
 */
import rehypeParse from "rehype-parse";
import { unified } from "unified";
import type { Element, RootContent } from "hast";
import site from "../../site.config.ts";
import type { AdPosition, AdSlot, PageType } from "../../shared/settings.ts";

export interface AdContext {
  type: PageType;
  categoryId?: number;
}

export function activeSlot(position: AdPosition, ctx: AdContext | undefined): AdSlot | null {
  const slot = site.ads?.slots[position];
  if (!ctx || !slot?.enabled || !slot.code.trim() || !slot.pageTypes.includes(ctx.type)) return null;
  if (ctx.categoryId !== undefined) {
    if (slot.includeCategories.length && !slot.includeCategories.includes(ctx.categoryId)) return null;
    if (slot.excludeCategories.includes(ctx.categoryId)) return null;
  }
  return slot;
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function adHtml(position: AdPosition, slot: AdSlot): string {
  const device = position === "mobileSticky" ? "ad-mobile" : slot.devices === "both" ? "" : `ad-${slot.devices}`;
  const cls = ["ad-slot", `ad-${position}`, device].filter(Boolean).join(" ");
  const close = position === "mobileSticky" ? '<button type="button" class="ad-close" aria-label="Fechar anúncio">×</button>' : "";
  return `<aside class="${cls}" style="min-height:${Math.round(slot.minHeight)}px" aria-label="Publicidade" data-pagefind-ignore data-ad-code="${attr(slot.code)}"><span class="ad-label">Publicidade</span>${close}<div class="ad-code"></div></aside>`;
}

const isElement = (n: RootContent): n is Element => n.type === "element";
const isBlank = (n: RootContent) => n.type === "text" && !n.value.trim();
const CLOSES_FLOW = /^(h[1-6]|section)$/;
/** Sumário, CTA, "Leia também" e cartão do autor, caso apareçam no próprio HTML do artigo. */
const PROTECTED = /(^|\s)(toc|cta-box|read-more|author-box)(\s|$)/;
const isProtected = (n: RootContent | undefined) => !!n && isElement(n) && (CLOSES_FLOW.test(n.tagName) || PROTECTED.test(String((n.properties.className as string[] | undefined)?.join(" ") ?? "")));

/**
 * Insere o anúncio depois do parágrafo N, contando só <p> de primeiro nível; assim, nunca entra dentro
 * de um bloco nem logo depois de um título. Se o lugar não servir, vai para o próximo parágrafo válido.
 * Também nunca fica colado antes de um título ou da seção de FAQ: o CTA e o "Leia também" entram antes de um H2, então também nunca ficam
 * ao lado; pelo mesmo motivo, não entra depois do último bloco (perto dos relacionados e do autor).
 */
export function insertInContent(html: string, slot: AdSlot): string {
  const blocks = unified().use(rehypeParse, { fragment: true }).parse(html).children.filter((n) => !isBlank(n));
  const every = Math.max(0, slot.repeatEvery ?? 0);
  const max = every > 0 ? Math.max(1, slot.maxBlocks ?? 1) : 1;
  let want = Math.max(1, slot.afterParagraph ?? 3);
  let count = 0;
  const offsets: number[] = [];
  for (const [i, node] of blocks.entries()) {
    if (!isElement(node) || node.tagName !== "p") continue;
    count++;
    if (count < want) continue;
    const next = blocks[i + 1];
    const end = node.position?.end.offset;
    if (!next || end === undefined || isProtected(next)) continue;
    offsets.push(end);
    if (offsets.length >= max) break;
    want = count + every;
  }
  const code = adHtml("inContent", slot);
  let out = html;
  for (const at of offsets.reverse()) out = out.slice(0, at) + code + out.slice(at);
  return out;
}
