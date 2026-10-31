/**
 * Processamento de imagens compartilhado entre o build do blog, o script de
 * exemplos e a API de publicação (Fase 4).
 *
 * Para cada imagem `/wp-content/uploads/AAAA/MM/nome` grava:
 *   nome.jpg                  JPEG progressivo otimizado (até MAX_WIDTH px, sem metadados);
 *                             é o `source_url` (abre na hora, sem esperar o build)
 *   nome.webp                 versão principal do HTML do blog (mesma largura)
 *   nome-<w>.webp             variantes em cada largura de WIDTHS menor que a principal
 *   nome-og.jpg               1200×630 para Open Graph
 *   nome.json                 metadados lidos pelo build (MediaMeta)
 * O arquivo enviado não é guardado (poderia conter GPS e outros dados EXIF).
 *
 * Imagens antigas continuam valendo como estão: original em `src`, variantes
 * `nome-<w>.webp|avif` e `formats` com "avif" no .json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { localDataDir } from "../src/lib/site-id.ts";

// Limita threads do libvips por processo (vários blogs no mesmo servidor)
if (process.env.SHARP_CONCURRENCY) sharp.concurrency(Number(process.env.SHARP_CONCURRENCY));

export const WIDTHS = [160, 480, 800, 1200] as const;
export const MAX_WIDTH = 1600;
const WEBP_QUALITY = 80;
const JPEG_QUALITY = 80;
/** Barra imagens que explodem ao descomprimir: 50 MP cobrem câmeras de 48 MP. */
export const MAX_INPUT_PIXELS = 50_000_000;
/** Prefixo público das imagens, igual ao do WordPress. */
export const PUBLIC_PREFIX = "/wp-content/uploads/";

const ACCEPTED_FORMATS = ["jpeg", "png", "webp"];

export interface MediaMeta {
  /** Caminho público da versão principal, ex.: /wp-content/uploads/2026/10/lisboa.webp */
  src: string;
  /** JPEG otimizado devolvido como `source_url`. Imagens antigas não têm. */
  jpeg?: string;
  width: number;
  height: number;
  widths: number[];
  formats: ("avif" | "webp")[];
  og: string;
  alt?: string;
}

export function uploadsRoot(): string {
  return path.resolve(process.env.UPLOADS_DIR ?? path.join(localDataDir(), "uploads"));
}

/** Nome de arquivo seguro: minúsculas, sem acento, só [a-z0-9-]. */
export function safeBaseName(name: string): string {
  const base = name
    .replace(/\.[a-z0-9]+$/i, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "imagem";
}

export async function processImage(
  input: Buffer,
  opts: { subdir: string; baseName: string; alt?: string; root?: string }
): Promise<MediaMeta> {
  const root = opts.root ?? uploadsRoot();
  const dir = path.join(root, opts.subdir);
  await mkdir(dir, { recursive: true });

  const base = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  const info = await base.metadata();
  if (!info.format || !ACCEPTED_FORMATS.includes(info.format) || !info.width || !info.height) {
    throw new Error(`Formato de imagem não suportado: ${info.format ?? "desconhecido"}`);
  }
  // Orientação EXIF 5–8 troca largura e altura
  const inputWidth = (info.orientation ?? 1) >= 5 ? info.height : info.width;

  // O sharp descarta EXIF, ICC e XMP por padrão (e converte para sRGB)
  const main = await base
    .clone()
    .resize({ width: Math.min(inputWidth, MAX_WIDTH) })
    .webp({ quality: WEBP_QUALITY })
    .toFile(path.join(dir, `${opts.baseName}.webp`));

  // JPEG não tem transparência: fundo branco, em vez do preto padrão
  await base
    .clone()
    .resize({ width: main.width })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
    .toFile(path.join(dir, `${opts.baseName}.jpg`));

  const smaller = WIDTHS.filter((w) => w < main.width);
  await Promise.all(
    smaller.map((w) =>
      base.clone().resize({ width: w }).webp({ quality: WEBP_QUALITY }).toFile(path.join(dir, `${opts.baseName}-${w}.webp`))
    )
  );

  await base
    .clone()
    .resize({ width: 1200, height: 630, fit: "cover", position: "attention" })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(path.join(dir, `${opts.baseName}-og.jpg`));

  const publicDir = `${PUBLIC_PREFIX}${opts.subdir}`.replace(/\/+/g, "/");
  const meta: MediaMeta = {
    src: `${publicDir}/${opts.baseName}.webp`,
    jpeg: `${publicDir}/${opts.baseName}.jpg`,
    width: main.width,
    height: main.height,
    widths: [...smaller, main.width],
    formats: ["webp"],
    og: `${publicDir}/${opts.baseName}-og.jpg`,
    ...(opts.alt ? { alt: opts.alt } : {}),
  };
  await writeFile(path.join(dir, `${opts.baseName}.json`), JSON.stringify(meta, null, 2));
  return meta;
}

const cache = new Map<string, MediaMeta | null>();

/** Lê os metadados de uma imagem pelo caminho público (`/wp-content/uploads/...`). */
export function readMediaMeta(publicSrc: string): MediaMeta | null {
  if (cache.has(publicSrc)) return cache.get(publicSrc)!;
  let meta: MediaMeta | null = null;
  if (publicSrc.startsWith(PUBLIC_PREFIX)) {
    const rel = publicSrc.slice(PUBLIC_PREFIX.length).replace(/\.[a-z0-9]+$/i, ".json");
    const file = path.join(uploadsRoot(), rel);
    if (!rel.includes("..") && existsSync(file)) meta = JSON.parse(readFileSync(file, "utf8")) as MediaMeta;
  }
  cache.set(publicSrc, meta);
  return meta;
}

/** Imagens antigas têm avif; as novas, só webp. */
export function bestFormat(meta: MediaMeta): "avif" | "webp" {
  return meta.formats.includes("avif") ? "avif" : "webp";
}

export function variantUrl(meta: MediaMeta, width: number, format: "avif" | "webp"): string {
  // Na imagem nova, a maior largura é o próprio arquivo principal
  if (!meta.formats.includes("avif") && width === meta.width) return meta.src;
  return meta.src.replace(/\.[a-z0-9]+$/i, `-${width}.${format}`);
}

export function srcset(meta: MediaMeta, format: "avif" | "webp"): string {
  return meta.widths.map((w) => `${variantUrl(meta, w, format)} ${w}w`).join(", ");
}
