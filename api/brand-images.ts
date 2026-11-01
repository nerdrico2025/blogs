/**
 * Originais do logotipo e do favicon, guardados sem metadados em <assets>/originais/ (nunca servidos),
 * e geração das imagens derivadas. Mudou o que é gerado? Aumente IMAGE_GENERATOR_VERSION:
 * no arranque seguinte, o servidor refaz tudo a partir dos originais e publica de novo.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import sharp from "sharp";
import { AUTHOR_PHOTO_WIDTHS, type Settings } from "../shared/settings.ts";
import { writeFavicons } from "./favicon.ts";

export const IMAGE_GENERATOR_VERSION = 1;
export const ORIGINALS_DIR = "originais";

export type BrandImageKind = "logo" | "logoDark" | "favicon";
const KINDS: BrandImageKind[] = ["logo", "logoDark", "favicon"];
const BASE_NAME: Record<BrandImageKind, string> = { logo: "logo", logoDark: "logo-dark", favicon: "favicon" };
const MAX_PIXELS = 50_000_000;

type Brand = NonNullable<Settings["brand"]>;
type BrandPatch = Pick<Brand, "logo" | "logoDark" | "favicon" | "faviconSet">;

/**
 * Tira metadados (EXIF, GPS, dados do editor). Imagem vira PNG, sem perda e com a rotação do EXIF já aplicada;
 * SVG continua texto, sem os blocos e atributos que os editores acrescentam (podem trazer caminhos da máquina).
 */
export async function cleanOriginal(input: Buffer): Promise<{ data: Buffer; ext: "png" | "svg" }> {
  const meta = await sharp(input, { failOn: "error", limitInputPixels: MAX_PIXELS }).metadata();
  if (meta.format !== "svg") return { data: await sharp(input, { failOn: "error", limitInputPixels: MAX_PIXELS }).rotate().png().toBuffer(), ext: "png" };
  const svg = input
    .toString("utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<metadata\b[\s\S]*?<\/metadata>/gi, "")
    .replace(/<sodipodi:namedview\b[\s\S]*?(?:\/>|<\/sodipodi:namedview>)/gi, "")
    .replace(/\s(?:inkscape|sodipodi|xmlns:inkscape|xmlns:sodipodi|xmlns:rdf|xmlns:cc|xmlns:dc)(?::[\w-]+)?="[^"]*"/gi, "");
  const data = Buffer.from(svg);
  await sharp(data, { failOn: "error", limitInputPixels: MAX_PIXELS }).metadata();
  return { data, ext: "svg" };
}

const originalPath = (assetsDir: string, kind: BrandImageKind, ext: string) => path.join(assetsDir, ORIGINALS_DIR, `${BASE_NAME[kind]}.${ext}`);

function findOriginal(assetsDir: string, kind: BrandImageKind): string | null {
  for (const ext of ["png", "svg"]) {
    const file = originalPath(assetsDir, kind, ext);
    if (existsSync(file)) return file;
  }
  return null;
}

async function saveOriginal(assetsDir: string, kind: BrandImageKind, data: Buffer, ext: "png" | "svg"): Promise<void> {
  const file = originalPath(assetsDir, kind, ext);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
  await rm(originalPath(assetsDir, kind, ext === "png" ? "svg" : "png"), { force: true });
}

/** Gera as derivadas de uma imagem e devolve o que muda em settings.brand. */
async function derive(assetsDir: string, kind: BrandImageKind, original: Buffer, generator: number): Promise<BrandPatch> {
  await mkdir(assetsDir, { recursive: true });
  if (kind === "favicon") {
    const faviconSet = await writeFavicons(original, assetsDir, generator);
    return { favicon: `/assets/favicon-192.png?v=${faviconSet.version}`, faviconSet };
  }
  // A versão do gerador entra no nome: conteúdo novo, endereço novo, e o cache não prende a imagem antiga
  const hash = createHash("sha256").update(original).update(String(generator)).digest("hex").slice(0, 10);
  const name = `${BASE_NAME[kind]}-${hash}.webp`;
  const out = await sharp(original, { failOn: "error", limitInputPixels: MAX_PIXELS }).rotate().resize({ height: 160, withoutEnlargement: true }).webp({ quality: 85 }).toFile(path.join(assetsDir, name));
  // Exibido com 40 px de altura; o arquivo maior serve para telas de alta densidade
  return { [kind]: { src: `/assets/${name}`, width: Math.round((out.width / out.height) * 40), height: 40 } };
}

/** Envio pelo painel: só guarda o original depois de as derivadas darem certo. */
export async function storeBrandImage(assetsDir: string, kind: BrandImageKind, input: Buffer): Promise<BrandPatch> {
  const { data, ext } = await cleanOriginal(input);
  const patch = await derive(assetsDir, kind, data, IMAGE_GENERATOR_VERSION);
  await saveOriginal(assetsDir, kind, data, ext);
  return patch;
}

/** Enviada pelo painel (a identidade provisória do assistente fica em /assets/brand/ e não é um envio). */
function wasUploaded(brand: Brand | undefined, kind: BrandImageKind): boolean {
  const src = kind === "favicon" ? brand?.favicon : brand?.[kind]?.src;
  return Boolean(src?.startsWith("/assets/") && !src.startsWith("/assets/brand/"));
}

/** Imagens enviadas antes de os originais serem guardados: só um novo envio resolve. */
export function missingOriginals(assetsDir: string, brand: Brand | undefined): BrandImageKind[] {
  return KINDS.filter((kind) => wasUploaded(brand, kind) && !findOriginal(assetsDir, kind));
}

const AUTHOR_ORIGINAL = "autor.png";

/** Foto quadrada, recortada no ponto de interesse, em WebP. O nome muda com o conteúdo, para o cache não prender a anterior. */
async function deriveAuthorPhoto(assetsDir: string, original: Buffer, generator: number): Promise<{ base: string }> {
  await mkdir(assetsDir, { recursive: true });
  const hash = createHash("sha256").update(original).update(String(generator)).digest("hex").slice(0, 10);
  for (const width of AUTHOR_PHOTO_WIDTHS) {
    await sharp(original, { failOn: "error", limitInputPixels: MAX_PIXELS }).resize({ width, height: width, fit: "cover", position: "attention" }).webp({ quality: 82 }).toFile(path.join(assetsDir, `autor-${hash}-${width}.webp`));
  }
  return { base: `/assets/autor-${hash}` };
}

/** Só imagem de verdade: foto de pessoa não precisa de SVG, e o original vai sem EXIF nem GPS. */
export async function storeAuthorPhoto(assetsDir: string, input: Buffer): Promise<{ base: string }> {
  const { data, ext } = await cleanOriginal(input);
  if (ext !== "png") throw new Error("a foto precisa ser PNG, JPG ou WebP");
  const photo = await deriveAuthorPhoto(assetsDir, data, IMAGE_GENERATOR_VERSION);
  const file = path.join(assetsDir, ORIGINALS_DIR, AUTHOR_ORIGINAL);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  return photo;
}

/** "Remover foto": apaga as versões e o original, para a imagem da pessoa não ficar no servidor. */
export async function removeAuthorPhoto(assetsDir: string): Promise<void> {
  await rm(path.join(assetsDir, ORIGINALS_DIR, AUTHOR_ORIGINAL), { force: true });
  if (!existsSync(assetsDir)) return;
  for (const f of await readdir(assetsDir)) if (/^autor-[0-9a-f]{10}-\d+\.webp$/.test(f)) await rm(path.join(assetsDir, f), { force: true });
}

export interface SyncDeps {
  assetsDir: string;
  settingsFile: string;
  settings: { current: Settings; update(fn: (s: Settings) => Settings): Promise<Settings> };
  builds: { request(reason: string): void };
  log: Pick<FastifyBaseLogger, "info" | "warn">;
}

/**
 * Arranque: se a versão do gerador mudou, refaz as derivadas e pede um rebuild. Nunca impede o servidor de subir.
 * Se algo falhar, a versão gravada não muda e o próximo arranque tenta de novo.
 * Nos logs, só o tipo da imagem: a mensagem de erro traria caminhos internos.
 */
export async function syncBrandImages(deps: SyncDeps, generator = IMAGE_GENERATOR_VERSION): Promise<BrandImageKind[]> {
  const { assetsDir, settings, builds, log } = deps;
  if (settings.current.imageGenerator === generator) return [];
  const regenerated: BrandImageKind[] = [];
  let patch: BrandPatch = {};
  let failed = false;
  for (const kind of KINDS) {
    const file = findOriginal(assetsDir, kind);
    if (!file || !wasUploaded(settings.current.brand, kind)) continue;
    try {
      patch = { ...patch, ...(await derive(assetsDir, kind, await readFile(file), generator)) };
      regenerated.push(kind);
    } catch {
      failed = true;
      log.warn({ kind }, "imagem da marca não regenerada; nova tentativa no próximo arranque");
    }
  }
  const authorOriginal = path.join(assetsDir, ORIGINALS_DIR, AUTHOR_ORIGINAL);
  let authorPhoto: { base: string } | undefined;
  if (settings.current.authorProfile?.photo && existsSync(authorOriginal)) {
    try {
      authorPhoto = await deriveAuthorPhoto(assetsDir, await readFile(authorOriginal), generator);
    } catch {
      failed = true;
      log.warn({ kind: "autor" }, "foto do autor não regenerada; nova tentativa no próximo arranque");
    }
  }
  try {
    // Blog novo, sem settings.json: nada a refazer, e criar o arquivo esconderia o settings.json inicial do site
    if (regenerated.length > 0 || authorPhoto || (!failed && existsSync(deps.settingsFile))) {
      await settings.update((s) => ({
        ...s,
        brand: regenerated.length > 0 ? { ...s.brand, ...patch } : s.brand,
        ...(authorPhoto && s.authorProfile ? { authorProfile: { ...s.authorProfile, photo: authorPhoto } } : {}),
        ...(failed ? {} : { imageGenerator: generator }),
      }));
    }
  } catch {
    log.warn("não foi possível gravar a versão do gerador de imagens; nova tentativa no próximo arranque");
    return [];
  }
  if (authorPhoto && regenerated.length === 0) builds.request("foto do autor regenerada");
  if (regenerated.length > 0) {
    log.info({ regenerated, generator }, "imagens da marca regeneradas a partir dos originais");
    builds.request("imagens da marca regeneradas");
  }
  return regenerated;
}
