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

export interface RedirectResult {
  content: string;
  added: number;
  total: number;
  skipped: string[];
}

/**
 * Junta as regras novas ao bloco gerado do redirects.txt (formato "/antigo/ /novo/" lido por
 * api/static.ts). Regras de importações anteriores continuam; o que está fora do bloco não é tocado,
 * e uma origem que já tem regra manual fica de fora.
 */
export function mergeRedirects(existing: string, rules: Map<string, string>): RedirectResult {
  const lines = existing.split("\n");
  const start = lines.indexOf(BLOCK_START);
  const end = lines.indexOf(BLOCK_END);
  const hasBlock = start !== -1 && end > start;
  const outside = hasBlock ? [...lines.slice(0, start), ...lines.slice(end + 1)] : lines;
  const block = hasBlock ? lines.slice(start + 1, end) : [];

  const manual = new Set(outside.map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/)[0]!));
  const merged = new Map<string, string>();
  for (const l of block) {
    const [from, to] = l.trim().split(/\s+/);
    if (from && to && !from.startsWith("#")) merged.set(from, to);
  }
  const skipped: string[] = [];
  let added = 0;
  for (const [from, to] of rules) {
    if (/\s/.test(from) || /\s/.test(to)) {
      skipped.push(`${from} (tem espaço no caminho)`);
      continue;
    }
    if (manual.has(from)) {
      skipped.push(`${from} (já tem regra manual)`);
      continue;
    }
    if (merged.get(from) !== to) added++;
    merged.set(from, to);
  }
  const body = [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([f, t]) => `${f} ${t}`);
  const head = outside.join("\n").replace(/\n+$/, "");
  const content = `${head ? `${head}\n\n` : ""}${BLOCK_START}\n${body.join("\n")}${body.length ? "\n" : ""}${BLOCK_END}\n`;
  return { content, added, total: merged.size, skipped };
}

export async function writeRedirects(file: string, rules: Map<string, string>, dryRun: boolean): Promise<RedirectResult> {
  const existing = existsSync(file) ? await readFile(file, "utf8") : "";
  const result = mergeRedirects(existing, rules);
  if (!dryRun) await writeFile(file, result.content);
  return result;
}
