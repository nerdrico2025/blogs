/** Grava o settings.json (atômico, uma escrita por vez) e atualiza a config em memória. */
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import site, { reloadSite } from "../site.config.ts";
import { hasSiteFolder } from "../src/lib/site-id.ts";
import { AD_POSITIONS, AUTHOR_LINKS, isHex, readSettings, type AdSlot, type AuthorProfile, type HomeLink, type HomeSettings, type Settings } from "../shared/settings.ts";
import type { Category } from "../src/lib/config-schema.ts";
import { WpError } from "./errors.ts";
import { slugify } from "./store.ts";

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

export function parseColors(b: Record<string, unknown>): { primary?: string; highlight?: string; callout?: string; header?: string } {
  const out: Record<string, string> = {};
  for (const key of ["primary", "highlight", "callout", "header"]) {
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

export const HOME_LIMITS = { icon: 16, title: 80, text: 300, label: 60, href: 500, buttonLabel: 40, kicker: 40, footer: 500, placeholder: 80, items: 6, clocks: 12 };

/** Interno começando com uma só barra, ou http(s) completo. Fora disso (javascript:, data:, //host) é recusado. */
export function validHref(href: string): boolean {
  if (/[\s\\\u0000-\u001f]/.test(href)) return false;
  if (href.startsWith("/")) return !href.startsWith("//");
  if (!/^https?:\/\//i.test(href)) return false;
  return URL.canParse(href);
}

const href = (v: unknown, label: string): string => {
  const value = str(v, label, HOME_LIMITS.href).trim();
  if (value && !validHref(value)) throw invalid(`${label}: use um endereço interno, como /sobre/, ou completo, como https://exemplo.com/.`);
  return value;
};

const button = (v: unknown, label: string): HomeLink => {
  const b = (v ?? {}) as Record<string, unknown>;
  const out = { label: str(b.label, `Texto do botão (${label})`, HOME_LIMITS.buttonLabel).trim(), href: href(b.href, `Link do botão (${label})`) };
  if (Boolean(out.label) !== Boolean(out.href)) throw invalid(`Botão (${label}): preencha o texto e o link, ou deixe os dois vazios.`);
  return out;
};

const validTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: tz });
    return Boolean(tz);
  } catch {
    return false;
  }
};

const optionalIcon = (b: Record<string, unknown>, label: string) => (b.icon === undefined ? {} : { icon: str(b.icon, label, HOME_LIMITS.icon).trim() });

/** Texto puro: quem escapa o HTML é o Astro, ao publicar. Linha toda vazia é ignorada. */
export function parseHome(b: Record<string, unknown>): HomeSettings {
  const home: HomeSettings = {};
  if (b.tools) {
    const t = b.tools as Record<string, unknown>;
    const rows = Array.isArray(t.items) ? (t.items as Record<string, unknown>[]) : [];
    const items = rows
      .map((it) => {
        const label = str(it?.label, "Texto do item", HOME_LIMITS.label).trim();
        const link = href(it?.href, "Link do item");
        const icon = str(it?.icon, "Emoji do item", HOME_LIMITS.icon).trim();
        return { icon, label, ...(link ? { href: link } : {}) };
      })
      .filter((it) => it.label || it.icon || it.href);
    if (items.length > HOME_LIMITS.items) throw invalid(`Caixa de recursos: são no máximo ${HOME_LIMITS.items} itens.`);
    if (items.some((it) => !it.label)) throw invalid("Caixa de recursos: todo item precisa de texto.");
    const tools = {
      enabled: t.enabled === true,
      ...optionalIcon(t, "Emoji da caixa de recursos"),
      title: str(t.title, "Título da caixa de recursos", HOME_LIMITS.title).trim(),
      text: str(t.text, "Descrição da caixa de recursos", HOME_LIMITS.text).trim(),
      items,
      button: button(t.button, "caixa de recursos"),
    };
    if (tools.enabled && !tools.title) throw invalid("Caixa de recursos ligada: preencha o título.");
    home.tools = tools;
  }
  if (b.callout) {
    const c = b.callout as Record<string, unknown>;
    const callout = {
      enabled: c.enabled === true,
      ...optionalIcon(c, "Emoji da caixa de destaque"),
      kicker: str(c.kicker, "Etiqueta da caixa de destaque", HOME_LIMITS.kicker).trim(),
      title: str(c.title, "Título da caixa de destaque", HOME_LIMITS.title).trim(),
      text: str(c.text, "Texto da caixa de destaque", HOME_LIMITS.text).trim(),
      button: button(c.button, "caixa de destaque"),
    };
    if (callout.enabled && !callout.title) throw invalid("Caixa de destaque ligada: preencha o título.");
    home.callout = callout;
  }
  if (b.ticker) {
    const t = b.ticker as Record<string, unknown>;
    const rows = Array.isArray(t.clocks) ? (t.clocks as Record<string, unknown>[]) : [];
    const clocks = rows
      .map((c) => ({ label: str(c?.label, "Nome da cidade", HOME_LIMITS.title).trim(), timezone: str(c?.timezone, "Fuso horário", HOME_LIMITS.title).trim() }))
      .filter((c) => c.label || c.timezone);
    if (clocks.length > HOME_LIMITS.clocks) throw invalid(`Faixa do topo: são no máximo ${HOME_LIMITS.clocks} cidades.`);
    for (const c of clocks) {
      if (!c.label) throw invalid("Faixa do topo: toda cidade precisa de nome.");
      if (!validTimezone(c.timezone)) throw invalid(`Fuso horário inválido em "${c.label}". Use o formato America/Sao_Paulo.`);
    }
    home.ticker = { enabled: t.enabled === true, showRates: t.showRates === true, showClocks: t.showClocks === true, clocks };
  }
  if (b.footerText !== undefined) home.footerText = str(b.footerText, "Texto do rodapé", HOME_LIMITS.footer).trim();
  if (b.searchPlaceholder !== undefined) home.searchPlaceholder = str(b.searchPlaceholder, "Texto da busca", HOME_LIMITS.placeholder).trim();
  return home;
}

export const AUTHOR_LIMITS = { name: 80, role: 80, bioShort: 200, bioFull: 5000, alt: 160, credentials: 6, credential: 160, specialties: 8, specialty: 60, url: 500, email: 200 };
const LINK_LABELS: Record<(typeof AUTHOR_LINKS)[number], string> = { site: "Site", instagram: "Instagram", linkedin: "LinkedIn", youtube: "YouTube", x: "X" };

function textList(v: unknown, label: string, max: number, maxLength: number): string[] {
  if (v !== undefined && !Array.isArray(v)) throw invalid(`${label}: lista inválida.`);
  const items = ((v ?? []) as unknown[]).map((it) => str(it, label, maxLength).trim()).filter(Boolean);
  if (items.length > max) throw invalid(`${label}: são no máximo ${max} itens.`);
  return items;
}

/** Texto puro: quem escapa o HTML é o Astro, ao publicar. Só a foto e o histórico de endereços vêm do que já estava salvo. */
export function parseAuthor(b: Record<string, unknown>, previous: AuthorProfile | undefined): AuthorProfile {
  const name = str(b.name, "Nome", AUTHOR_LIMITS.name).trim();
  const input = (b.links ?? {}) as Record<string, unknown>;
  const links: AuthorProfile["links"] = {};
  for (const key of AUTHOR_LINKS) {
    const url = str(input[key], LINK_LABELS[key], AUTHOR_LIMITS.url).trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url) || !validHref(url)) throw invalid(`${LINK_LABELS[key]}: use um endereço completo, como https://exemplo.com/.`);
    links[key] = url;
  }
  const email = str(b.email, "E-mail público", AUTHOR_LIMITS.email).trim();
  if (email && !/^[^\s@<>"'&?]+@[^\s@<>"'&?]+\.[^\s@<>"'&?]+$/.test(email)) throw invalid("E-mail público: confira o endereço.");
  // Sem nome, o endereço anterior é mantido: o autor pode ser cadastrado de novo
  const slug = name ? slugify(name) || "autor" : previous?.slug ?? "";
  const aliases = new Set(previous?.aliases ?? []);
  if (previous?.slug && previous.slug !== slug) aliases.add(previous.slug);
  aliases.delete(slug);
  return {
    name,
    slug,
    ...(aliases.size ? { aliases: [...aliases] } : {}),
    role: str(b.role, "Cargo", AUTHOR_LIMITS.role).trim(),
    bioShort: str(b.bioShort, "Bio curta", AUTHOR_LIMITS.bioShort).trim(),
    bioFull: str(b.bioFull, "Bio completa", AUTHOR_LIMITS.bioFull).trim(),
    ...(previous?.photo ? { photo: previous.photo } : {}),
    photoAlt: str(b.photoAlt, "Texto alternativo da foto", AUTHOR_LIMITS.alt).trim(),
    credentials: textList(b.credentials, "Credenciais", AUTHOR_LIMITS.credentials, AUTHOR_LIMITS.credential),
    specialties: textList(b.specialties, "Áreas de especialidade", AUTHOR_LIMITS.specialties, AUTHOR_LIMITS.specialty),
    links,
    email,
  };
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
