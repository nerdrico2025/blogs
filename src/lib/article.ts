/**
 * Divide o HTML do artigo antes de determinados H2 de nível superior, para
 * inserir componentes (CTA, "Leia também") no meio do texto sem JS.
 */
const FAQ_OPEN = '<section class="faq">';

/** Posições (índice no HTML) de cada H2 de nível superior. O H2 do FAQ conta pelo início da seção. */
export function h2Offsets(html: string): number[] {
  const out: number[] = [];
  const re = /<h2[\s>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const i = m.index;
    out.push(html.slice(Math.max(0, i - FAQ_OPEN.length), i) === FAQ_OPEN ? i - FAQ_OPEN.length : i);
  }
  return out;
}

export interface Slot<T extends string> {
  html: string;
  /** Componente a renderizar depois deste trecho. */
  after?: T;
}

/**
 * Insere cada slot antes do H2 de número `before` (1 = primeiro H2).
 * Slots que não cabem (texto com poucos H2) são ignorados.
 */
export function splitAt<T extends string>(html: string, inserts: { key: T; before: number }[]): Slot<T>[] {
  const offsets = h2Offsets(html);
  const points = inserts
    .filter((ins) => ins.before >= 1 && ins.before <= offsets.length)
    .map((ins) => ({ key: ins.key, at: offsets[ins.before - 1]! }))
    .sort((a, b) => a.at - b.at);
  const slots: Slot<T>[] = [];
  let last = 0;
  for (const p of points) {
    slots.push({ html: html.slice(last, p.at), after: p.key });
    last = p.at;
  }
  slots.push({ html: html.slice(last) });
  return slots;
}

/** Escolhe as posições do CTA e do "Leia também" conforme o número de H2 do texto. */
export function placements(h2Count: number, ctaBefore: number, readMoreBefore: number): { cta?: number; readMore?: number } {
  if (h2Count < 2) return {};
  const cta = h2Count >= ctaBefore ? ctaBefore : Math.max(2, Math.ceil(h2Count / 2));
  let readMore: number | undefined = h2Count >= readMoreBefore ? readMoreBefore : h2Count;
  if (readMore <= cta) readMore = undefined;
  return { cta, readMore };
}
