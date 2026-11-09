/**
 * --suggest-categories: sugere o mapeamento de categorias (origem WordPress → blog) sem importar nada.
 * Lê só a origem (categorias e títulos dos posts) e as categorias do site.config.ts do blog; nunca chama
 * a API do destino e nunca cria categoria. Sem correspondência razoável, o destino fica "?".
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { htmlText } from "./html.ts";
import { CategoryMapper } from "./mapping.ts";
import { fetchWithRetry } from "./source.ts";

export interface SuggestSourceCategory {
  id: number;
  name: string;
  slug: string;
  count: number;
  parent: number;
}

export interface SuggestTarget {
  id: number;
  slug: string;
  name: string;
  description?: string;
}

export interface SuggestPost {
  title: string;
  categories: number[];
}

export type Confidence = "alta" | "média" | "baixa";

export interface Suggestion {
  source: SuggestSourceCategory;
  /** Slug da categoria do blog, ou "?" para decidir à mão. */
  target: string;
  confidence: Confidence | null;
  /** Como chegou ao destino: nome/slug, palavras dos títulos, herdado do pai, ou nenhum. */
  reason: "nome" | "palavras" | "pai" | "nenhum";
  depth: number;
}

/** Limiares da semelhança de nome/slug (0 a 1). */
export const NAME_HIGH = 0.8;
export const NAME_MEDIUM = 0.5;

const STOPWORDS = new Set(
  "a o as os de da do das dos e em no na nos nas um uma uns umas para pra por com sem que como mais menos seu sua seus suas ao aos se ou the and of to for in on guia dicas dica tudo sobre voce você ja já ate até".split(" ")
);

/** Sem acento, minúsculo, só letras e números. */
export function plain(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Singular simples do português (e o "s" do inglês): cartões → cartao, investimentos → investimento. */
export function singular(w: string): string {
  if (w.length <= 3) return w;
  if (/(oes|aes)$/.test(w)) return w.slice(0, -3) + "ao";
  if (/ais$/.test(w)) return w.slice(0, -3) + "al";
  if (/eis$/.test(w)) return w.slice(0, -3) + "el";
  if (/ns$/.test(w)) return w.slice(0, -2) + "m";
  if (/(res|zes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}

export const tokens = (s: string): string[] => plain(s).split(" ").filter((w) => w && !STOPWORDS.has(w)).map(singular);

function bigrams(s: string): string[] {
  const t = ` ${s} `;
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const count = new Map<string, number>();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  let hits = 0;
  for (const x of b) {
    const n = count.get(x) ?? 0;
    if (n > 0) {
      hits++;
      count.set(x, n - 1);
    }
  }
  return (2 * hits) / (a.length + b.length);
}

/** Semelhança entre dois nomes ou slugs: palavras em comum e, para grafias parecidas, pares de letras. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const joinedA = ta.join(" ");
  const joinedB = tb.join(" ");
  if (joinedA === joinedB) return 1;
  const setA = new Set(ta);
  const setB = new Set(tb);
  const common = [...setA].filter((w) => setB.has(w)).length;
  // Uma contida na outra ("Renda extra online" e "Renda extra") conta quase como igual
  const contained = common > 0 && (common === setA.size || common === setB.size) ? 0.85 * (common / Math.max(setA.size, setB.size)) + 0.15 : 0;
  return Math.max(dice([...setA], [...setB]), contained, 0.9 * dice(bigrams(joinedA), bigrams(joinedB)));
}

function bestByName(c: SuggestSourceCategory, targets: SuggestTarget[]): { target: SuggestTarget; score: number } | null {
  let best: { target: SuggestTarget; score: number } | null = null;
  for (const t of targets) {
    const score = Math.max(similarity(c.name, t.name), similarity(c.slug, t.slug), similarity(c.name, t.slug), similarity(c.slug, t.name));
    if (!best || score > best.score) best = { target: t, score };
  }
  return best;
}

/** Palavras dos títulos dos posts da categoria contra nome, slug e descrição de cada destino. */
function bestByKeywords(titles: string[], targets: SuggestTarget[]): { target: SuggestTarget; score: number; margin: number } | null {
  if (!titles.length) return null;
  const words = titles.flatMap((t) => [...new Set(tokens(t))]);
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scores = targets
    .map((t) => {
      const vocab = new Set(tokens(`${t.name} ${t.slug.replace(/-/g, " ")} ${t.description ?? ""}`));
      let hits = 0;
      for (const [w, n] of freq) if (vocab.has(w)) hits += n;
      return { target: t, score: hits / titles.length };
    })
    .sort((a, b) => b.score - a.score);
  const [first, second] = scores;
  if (!first || first.score === 0) return null;
  return { ...first, margin: first.score - (second?.score ?? 0) };
}

/**
 * Sugestão por categoria de origem. Ordem: pais antes dos filhos (o filho herda o destino do pai,
 * salvo nome mais parecido com outro destino).
 */
export function suggestCategories(source: SuggestSourceCategory[], posts: SuggestPost[], targets: SuggestTarget[]): Suggestion[] {
  const byId = new Map(source.map((c) => [c.id, c]));
  const depthOf = (c: SuggestSourceCategory, seen = new Set<number>()): number => {
    const p = byId.get(c.parent);
    if (!p || seen.has(p.id)) return 0;
    seen.add(c.id);
    return 1 + depthOf(p, seen);
  };
  const ordered = [...source].sort((a, b) => depthOf(a) - depthOf(b) || b.count - a.count || a.slug.localeCompare(b.slug));
  const result = new Map<number, Suggestion>();
  for (const c of ordered) {
    const depth = depthOf(c);
    const named = bestByName(c, targets);
    const parent = result.get(c.parent);
    let s: Suggestion;
    if (named && named.score >= NAME_HIGH) s = { source: c, target: named.target.slug, confidence: "alta", reason: "nome", depth };
    else if (named && named.score >= NAME_MEDIUM) s = { source: c, target: named.target.slug, confidence: "média", reason: "nome", depth };
    else if (parent && parent.target !== "?") s = { source: c, target: parent.target, confidence: parent.confidence === "alta" ? "média" : "baixa", reason: "pai", depth };
    else {
      const titles = posts.filter((p) => p.categories.includes(c.id)).map((p) => p.title);
      const kw = bestByKeywords(titles, targets);
      // Palavras só decidem com folga sobre o segundo colocado; empate fica para você
      if (kw && kw.margin > 0) s = { source: c, target: kw.target.slug, confidence: kw.score >= 0.5 && kw.margin >= 0.25 ? "média" : "baixa", reason: "palavras", depth };
      else s = { source: c, target: "?", confidence: null, reason: "nenhum", depth };
    }
    result.set(c.id, s);
  }
  return ordered.map((c) => result.get(c.id)!);
}

const REASON: Record<Suggestion["reason"], string> = { nome: "pelo nome", palavras: "pelos títulos dos posts", pai: "herdado da categoria pai", nenhum: "sem correspondência: decida" };

/** Arquivo no formato de categorias.exemplo.txt: subcategorias antes (a primeira regra que bate vale). */
export function formatSuggestion(list: Suggestion[], meta: { from: string; blog: string }): string {
  const lines = [...list].sort((a, b) => b.depth - a.depth || b.source.count - a.source.count || a.source.slug.localeCompare(b.source.slug));
  const width = Math.max(...lines.map((s) => `${s.source.slug} => ${s.target}`.length), 10);
  return [
    `# Mapeamento de categorias sugerido: ${meta.from} => sites/${meta.blog}`,
    "# Gerado por --suggest-categories. Revise antes de importar: troque cada \"?\" por uma categoria do blog",
    "# (slug, nome ou id) ou apague a linha. Enquanto houver \"?\", a importação e o --dry-run param.",
    "# Num post com várias categorias vale a PRIMEIRA regra que bater: as subcategorias vêm antes.",
    "# \"* => <categoria>\" vale para qualquer categoria sem regra.",
    ...lines.map((s) => {
      const rule = `${s.source.slug} => ${s.target}`;
      const conf = s.confidence ? `confiança ${s.confidence}` : "confiança: ?";
      return `${rule.padEnd(width)}  # ${conf} (${REASON[s.reason]}), ${s.source.count} post(s)${s.source.name !== s.source.slug ? `, "${s.source.name}"` : ""}`;
    }),
    "",
  ].join("\n");
}

/** Posts por destino, com a mesma regra da importação (a primeira regra do arquivo que bate). */
export function postsPerTarget(list: Suggestion[], posts: SuggestPost[], targets: SuggestTarget[]): Map<string, number> {
  const rules = [...list].sort((a, b) => b.depth - a.depth || b.source.count - a.source.count || a.source.slug.localeCompare(b.source.slug)).filter((s) => s.target !== "?");
  const undecided = new Set(list.filter((s) => s.target === "?").map((s) => s.source.id));
  const mapper = new CategoryMapper(rules.map((s) => ({ from: s.source.slug, to: s.target })), targets.map((t) => ({ id: t.id, slug: t.slug, name: t.name })));
  const byId = new Map(list.map((s) => [s.source.id, s.source]));
  const total = new Map<string, number>();
  for (const p of posts) {
    const cats = p.categories.flatMap((id) => {
      const c = byId.get(id);
      return c ? [{ slug: c.slug, name: c.name, path: "" }] : [];
    });
    const to = mapper.forPost(cats);
    const key = to ? to.slug : p.categories.some((id) => undecided.has(id)) ? "?" : "(sem regra)";
    total.set(key, (total.get(key) ?? 0) + 1);
  }
  return total;
}

async function getJson<T>(url: string): Promise<{ data: T; pages: number }> {
  const res = await fetchWithRetry(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  try {
    return { data: JSON.parse(body) as T, pages: Number(res.headers.get("x-wp-totalpages") ?? 1) };
  } catch {
    throw new Error(`GET ${url} não devolveu JSON (a REST API está bloqueada?)`);
  }
}

async function all<T>(url: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const { data, pages } = await getJson<T[]>(`${url}&page=${page}`);
    out.push(...data);
    if (page >= pages) return out;
  }
}

/** Arquivo de saída: o pedido, ou <pedido>.sugerido se ele já existir (nunca sobrescreve um mapeamento). */
export const outputFile = (file: string) => (existsSync(file) ? `${file}.sugerido` : file);

export async function runSuggest(opts: { from: string; blog: string; file: string; targets: SuggestTarget[] }): Promise<void> {
  const api = `${opts.from.replace(/\/+$/, "")}/wp-json/wp/v2`;
  const source = (await all<SuggestSourceCategory>(`${api}/categories?per_page=100&_fields=id,name,slug,count,parent`)).map((c) => ({ ...c, name: htmlText(c.name) }));
  const posts = (await all<{ title: { rendered: string }; categories: number[] }>(`${api}/posts?per_page=100&_fields=id,title,categories`)).map((p) => ({ title: htmlText(p.title.rendered), categories: p.categories }));
  const list = suggestCategories(source, posts, opts.targets);

  const file = outputFile(opts.file);
  await writeFile(file, formatSuggestion(list, opts));

  const rows = [...list].sort((a, b) => b.depth - a.depth || b.source.count - a.source.count || a.source.slug.localeCompare(b.source.slug));
  const head = ["Origem", "Destino", "Confiança", "Posts"];
  const body = rows.map((s) => [`${"  ".repeat(s.depth)}${s.source.slug}`, s.target, s.confidence ?? "?", String(s.source.count)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => (i === 3 ? c.padStart(w[i]!) : c.padEnd(w[i]!))).join("  ");
  console.log(`Origem: ${opts.from} (${source.length} categorias, ${posts.length} posts publicados)`);
  console.log(`Destino: categorias de sites/${opts.blog} (${opts.targets.map((t) => t.slug).join(", ")})\n`);
  console.log(line(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of body) console.log(line(r));

  const totals = postsPerTarget(list, posts, opts.targets);
  console.log("\nPosts por destino (cada post conta uma vez, pela primeira regra que bate):");
  for (const t of opts.targets) console.log(`  ${t.slug.padEnd(Math.max(...opts.targets.map((x) => x.slug.length)))}  ${totals.get(t.slug) ?? 0}`);
  for (const k of ["?", "(sem regra)"]) if (totals.get(k)) console.log(`  ${k}  ${totals.get(k)}${k === "?" ? "  (decida no arquivo)" : ""}`);
  console.log(`\nArquivo gravado: ${file}${file !== opts.file ? ` (${opts.file} já existia e não foi alterado)` : ""}`);
  console.log("Nada foi importado. Revise o arquivo e use-o com --categories.");
}
