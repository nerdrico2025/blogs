/**
 * Mapeamento de categorias (de/para) e arquivo de redirecionamentos 301.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { BlogCategory } from "./blog.ts";
import type { SourceCategory } from "./source.ts";

export interface CategoryRule {
  from: string;
  to: string;
}

/**
 * Lê o arquivo de mapeamento. Formatos aceitos:
 *   JSON objeto:  { "slug-ou-nome-antigo": "slug-nome-ou-id-novo", "*": "padrao" }
 *   JSON lista:   [{ "de": "...", "para": "..." }]
 *   Texto:        uma regra por linha, "antigo => novo", "antigo,novo" ou "antigo;novo" (# comenta)
 * A ordem importa: num post com várias categorias, vale a primeira regra do arquivo que bater.
 * "*" vale para qualquer categoria sem regra.
 */
export function parseCategoryMap(text: string): CategoryRule[] {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    const data = JSON.parse(t) as unknown;
    if (Array.isArray(data)) {
      return data.map((r: Record<string, unknown>) => ({ from: String(r.de ?? r.from ?? ""), to: String(r.para ?? r.to ?? "") })).filter((r) => r.from && r.to);
    }
    return Object.entries(data as Record<string, unknown>).map(([from, to]) => ({ from, to: String(to) }));
  }
  return t
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const [from, to] = l.split(/\s*(?:=>|->|,|;|\t)\s*/);
      if (!from || !to) throw new Error(`mapeamento de categorias: linha inválida "${l}" (use "antigo => novo")`);
      return { from, to };
    });
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function findTarget(value: string, targets: BlogCategory[]): BlogCategory | undefined {
  const v = norm(value);
  return targets.find((c) => String(c.id) === value.trim() || c.slug === v || norm(c.name) === v);
}

export class CategoryMapper {
  private readonly rules: { from: string; to: BlogCategory }[] = [];
  readonly problems: string[] = [];

  constructor(rules: CategoryRule[], targets: BlogCategory[]) {
    for (const r of rules) {
      const to = findTarget(r.to, targets);
      if (!to) this.problems.push(`"${r.from}" → "${r.to}": categoria de destino não existe no blog (há: ${targets.map((c) => c.slug).join(", ")})`);
      else this.rules.push({ from: r.from, to });
    }
  }

  private matches(rule: string, c: SourceCategory): boolean {
    return rule === c.slug || norm(rule) === norm(c.name) || norm(rule) === c.slug;
  }

  /** Categoria de destino de um post (pela ordem das regras), ou null. */
  forPost(categories: SourceCategory[]): BlogCategory | null {
    for (const r of this.rules) {
      if (r.from === "*") continue;
      if (categories.some((c) => this.matches(r.from, c))) return r.to;
    }
    return this.rules.find((r) => r.from === "*")?.to ?? null;
  }

  /** Destino de uma categoria antiga (para links e redirects), sem usar o "*". */
  forCategory(c: SourceCategory): BlogCategory | null {
    return this.rules.find((r) => r.from !== "*" && this.matches(r.from, c))?.to ?? null;
  }
}

// ---------------------------------------------------------------- redirects

export const BLOCK_START = "# >>> importado do WordPress (scripts/import-wordpress). Gerado: não edite dentro deste bloco.";
export const BLOCK_END = "# <<< fim da importação do WordPress";

export const ORIGIN_PREFIX = "# origem: ";

export interface RedirectConflict {
  from: string;
  /** Destino que esta importação queria. */
  to: string;
  /** Destino que ficou valendo. */
  kept: string;
  /** Dona da regra: outra origem, ou "regra antiga sem origem". */
  owner: string;
}

export interface RedirectResult {
  content: string;
  added: number;
  total: number;
  skipped: string[];
  /** Caminhos que já são de outra origem (ou de regra antiga com outro destino): ficaram como estavam. */
  conflicts: RedirectConflict[];
  /** Regras antigas sem origem, com o mesmo destino, que passaram para a seção desta origem. */
  adopted: number;
}

/**
 * Junta as regras novas ao bloco gerado do redirects.txt (formato "/antigo/ /novo/" lido por
 * api/static.ts). Dentro do bloco, cada origem tem a sua seção ("# origem: dominio"): uma importação só
 * mexe na seção da própria origem. Caminho que já é de outra origem não muda e vira conflito no relatório.
 * Regras antigas, de antes das seções, são adotadas pela origem que gera a mesma regra; com outro
 * destino, viram conflito. O que está fora do bloco não é tocado, e caminho com regra manual fica de fora.
 * Sem `origin` (uso antigo), tudo vai para as regras sem seção, como antes.
 */
export function mergeRedirects(existing: string, rules: Map<string, string>, origin?: string): RedirectResult {
  const lines = existing.split("\n");
  const start = lines.indexOf(BLOCK_START);
  const end = lines.indexOf(BLOCK_END);
  const hasBlock = start !== -1 && end > start;
  const outside = hasBlock ? [...lines.slice(0, start), ...lines.slice(end + 1)] : lines;
  const block = hasBlock ? lines.slice(start + 1, end) : [];

  const manual = new Set(outside.map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/)[0]!));
  // Dono de cada caminho: "" = regra antiga, sem seção
  const owner = new Map<string, string>();
  const target = new Map<string, string>();
  let section = "";
  for (const l of block) {
    const t = l.trim();
    if (t.startsWith(ORIGIN_PREFIX)) {
      section = t.slice(ORIGIN_PREFIX.length).trim();
      continue;
    }
    const [from, to] = t.split(/\s+/);
    if (from && to && !from.startsWith("#")) {
      owner.set(from, section);
      target.set(from, to);
    }
  }
  const mine = origin ?? "";
  const skipped: string[] = [];
  const conflicts: RedirectConflict[] = [];
  let added = 0;
  let adopted = 0;
  for (const [from, to] of rules) {
    if (/\s/.test(from) || /\s/.test(to)) {
      skipped.push(`${from} (tem espaço no caminho)`);
      continue;
    }
    if (manual.has(from)) {
      skipped.push(`${from} (já tem regra manual)`);
      continue;
    }
    const current = owner.get(from);
    if (current !== undefined && current !== mine) {
      if (current === "" && target.get(from) === to) {
        owner.set(from, mine);
        adopted++;
      } else if (target.get(from) !== to) {
        conflicts.push({ from, to, kept: target.get(from)!, owner: current || "regra antiga sem origem" });
      }
      continue;
    }
    if (target.get(from) !== to) added++;
    owner.set(from, mine);
    target.set(from, to);
  }
  const sections = [...new Set(owner.values())].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  const body = sections.flatMap((sec) => {
    const rows = [...owner].filter(([, o]) => o === sec).map(([f]) => f).sort((a, b) => a.localeCompare(b)).map((f) => `${f} ${target.get(f)}`);
    return sec ? [`${ORIGIN_PREFIX}${sec}`, ...rows] : rows;
  });
  const head = outside.join("\n").replace(/\n+$/, "");
  const content = `${head ? `${head}\n\n` : ""}${BLOCK_START}\n${body.join("\n")}${body.length ? "\n" : ""}${BLOCK_END}\n`;
  return { content, added, total: owner.size, skipped, conflicts, adopted };
}

export async function writeRedirects(file: string, rules: Map<string, string>, dryRun: boolean, origin?: string): Promise<RedirectResult> {
  const existing = existsSync(file) ? await readFile(file, "utf8") : "";
  const result = mergeRedirects(existing, rules, origin);
  if (!dryRun) await writeFile(file, result.content);
  return result;
}
