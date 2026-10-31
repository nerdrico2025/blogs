/** Grava o settings.json (atômico, uma escrita por vez) e atualiza a config em memória. */
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import site, { reloadSite } from "../site.config.ts";
import { hasSiteFolder } from "../src/lib/site-id.ts";
import { AD_POSITIONS, isHex, readSettings, type AdSlot, type Settings } from "../shared/settings.ts";
import type { Category } from "../src/lib/config-schema.ts";
import { WpError } from "./errors.ts";

const invalid = (msg: string) => new WpError(400, "invalid_settings", msg);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CODE = 100_000;

const str = (v: unknown, label: string, max = 500): string => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw invalid(`${label}: valor inválido.`);
  if (v.length > max) throw invalid(`${label}: texto longo demais (máximo ${max} caracteres).`);
  return v;
};

export class SettingsStore {
  private readonly file: string;
  private readonly projectDir: string;
  private queue: Promise<unknown> = Promise.resolve();
  current: Settings;

  constructor(file: string, projectDir: string) {
    this.file = file;
    this.projectDir = projectDir;
    this.current = readSettings(file);
  }

  isConfigured(): boolean {
    return hasSiteFolder(this.projectDir) || this.current.configured === true;
  }

  update(fn: (s: Settings) => Settings): Promise<Settings> {
    const run = this.queue.then(async () => {
      const next = fn(structuredClone(this.current));
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2));
      await rename(tmp, this.file);
      this.current = next;
      reloadSite(next);
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export function parseColors(b: Record<string, unknown>): { primary?: string; highlight?: string; callout?: string } {
  const out: Record<string, string> = {};
  for (const key of ["primary", "highlight", "callout"]) {
    const v = b[key];
    if (v === "" || v === undefined || v === null) continue;
    if (!isHex(v)) throw invalid(`Cor inválida: ${String(v)} (use o formato #1363df).`);
    out[key] = v;
  }
  return out;
}

export function parseTracking(b: Record<string, unknown>) {
  const gtmId = str(b.gtmId, "ID do Tag Manager", 30).trim().toUpperCase();
  if (gtmId && !/^GTM-[A-Z0-9]+$/.test(gtmId)) throw invalid("O ID do Tag Manager tem o formato GTM-XXXXXXX.");
  return { gtmId, headCode: str(b.headCode, "Código no <head>", MAX_CODE), bodyCode: str(b.bodyCode, "Código antes do </body>", MAX_CODE) };
}

const int = (v: unknown, label: string, min: number, max: number, def: number): number => {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${label}: use um número de ${min} a ${max}.`);
  return n;
};

const ids = (v: unknown, known: Set<number>): number[] => {
  if (!Array.isArray(v)) return [];
  return v.map(Number).filter((n) => {
    if (!known.has(n)) throw invalid(`Categoria ${n} não existe.`);
    return true;
  });
};

export function parseAds(b: Record<string, unknown>) {
  const known = new Set(site.categories.map((c) => c.id));
  const input = (b.slots ?? {}) as Record<string, Record<string, unknown>>;
  const slots: Partial<Record<(typeof AD_POSITIONS)[number], AdSlot>> = {};
  for (const position of AD_POSITIONS) {
    const s = input[position];
    if (!s) continue;
    const devices = s.devices === "desktop" || s.devices === "mobile" ? s.devices : "both";
    const pageTypes = (Array.isArray(s.pageTypes) ? s.pageTypes : []).filter((t) => ["home", "article", "category"].includes(t as string)) as AdSlot["pageTypes"];
    if (position === "inContent" && pageTypes.some((t) => t !== "article")) throw invalid("Dentro do conteúdo só vale para artigos.");
    const slot: AdSlot = {
      enabled: s.enabled === true,
      code: str(s.code, `Código da posição ${position}`, MAX_CODE),
      devices: position === "mobileSticky" ? "mobile" : devices,
      pageTypes,
      includeCategories: ids(s.includeCategories, known),
      excludeCategories: ids(s.excludeCategories, known),
      minHeight: int(s.minHeight, "Altura reservada", 0, 1000, position === "mobileSticky" ? 60 : 250),
    };
    if (position === "inContent") {
      slot.afterParagraph = int(s.afterParagraph, "Depois do parágrafo", 1, 100, 3);
      slot.repeatEvery = int(s.repeatEvery, "Repetir a cada", 0, 100, 0);
      slot.maxBlocks = int(s.maxBlocks, "Máximo de blocos", 1, 20, 1);
    }
    if (slot.enabled && !slot.code.trim()) throw invalid(`A posição ${position} está ativa, mas sem código.`);
    if (slot.enabled && slot.pageTypes.length === 0) throw invalid(`A posição ${position} está ativa, mas sem tipo de página.`);
    slots[position] = slot;
  }
  return { headScript: str(b.headScript, "Script da rede", MAX_CODE), adsTxt: str(b.adsTxt, "ads.txt", MAX_CODE), slots };
}

export function validSlug(slug: string): boolean {
  return SLUG.test(slug) && slug.length <= 80;
}

/**
 * Categorias: nenhum id some ou muda; categoria nova ganha um id inédito (nunca reaproveitado,
 * mesmo por `nextCategoryId`). Slug trocado vira alias, para os posts antigos e as URLs antigas.
 */
export function mergeCategories(existing: Category[], input: unknown, nextId: number | undefined): { categories: Category[]; nextCategoryId: number } {
  if (!Array.isArray(input)) throw invalid("Lista de categorias inválida.");
  const byId = new Map(existing.map((c) => [c.id, c]));
  let next = Math.max(nextId ?? 0, ...existing.map((c) => c.id + 1), 2);
  const seen = new Set<number>();
  const categories: Category[] = (input as Record<string, unknown>[]).map((c) => {
    const name = str(c.name, "Nome da categoria", 80).trim();
    const slug = str(c.slug, "Slug da categoria", 80).trim();
    const description = str(c.description, "Descrição da categoria", 300).trim();
    if (!name) throw invalid("Toda categoria precisa de nome.");
    if (!validSlug(slug)) throw invalid(`Slug inválido: "${slug}". Use letras minúsculas sem acento, números e hífen.`);
    if (c.id === undefined || c.id === null || c.id === "") return { id: next++, slug, name, description };
    const id = Number(c.id);
    const old = byId.get(id);
    if (!old) throw invalid(`Categoria ${String(c.id)} não existe. Categoria nova vai sem id.`);
    if (seen.has(id)) throw invalid(`Categoria ${id} repetida.`);
    seen.add(id);
    const aliases = new Set(old.aliases ?? []);
    if (old.slug !== slug) aliases.add(old.slug);
    aliases.delete(slug);
    return { id, slug, name, description, ...(aliases.size ? { aliases: [...aliases] } : {}) };
  });
  for (const c of existing) if (!seen.has(c.id)) throw invalid(`A categoria "${c.name}" não pode ser apagada: o Wordbee guarda o id dela.`);
  const taken = new Map<string, number>();
  for (const c of categories) {
    for (const s of [c.slug, ...(c.aliases ?? [])]) {
      if (taken.has(s) && taken.get(s) !== c.id) throw invalid(`O slug "${s}" já é, ou já foi, de outra categoria.`);
      taken.set(s, c.id);
    }
  }
  return { categories, nextCategoryId: next };
}
