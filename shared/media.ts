/**
 * Processamento de imagens compartilhado entre o build do blog, o script de
 * exemplos e a API de publicação (Fase 4).
 *
 * Para cada imagem `/wp-content/uploads/AAAA/MM/nome` grava:
 *   nome.jpg|png|webp         o arquivo original, como foi enviado; é o `source_url`
 *                             (abre na hora, servido direto pelo Nginx, sem esperar o build)
 *   nome-<w>.webp|avif        variantes em cada largura de WIDTHS que caiba no original
 *   nome-og.jpg               1200×630 para Open Graph
 *   nome.json                 metadados lidos pelo build (MediaMeta)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { localDataDir } from "../src/lib/site-id.ts";

// Limita threads do libvips por processo (vários blogs no mesmo servidor)
if (process.env.SHARP_CONCURRENCY) sharp.concurrency(Number(process.env.SHARP_CONCURRENCY));

export const WIDTHS = [150, 480, 768, 1024, 1920] as const;
/** Prefixo público das imagens, igual ao do WordPress. */
export const PUBLIC_PREFIX = "/wp-content/uploads/";

const ORIGINAL_EXT: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp" };

export interface MediaMeta {
  /** Caminho público do original, ex.: /wp-content/uploads/2026/10/lisboa.png */
  src: string;
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

  const base = sharp(input, { failOn: "error" }).rotate();
  const info = await base.metadata();
  const ext = info.format ? ORIGINAL_EXT[info.format] : undefined;
  if (!ext || !info.width || !info.height) throw new Error(`Formato de imagem não suportado: ${info.format ?? "desconhecido"}`);
  // Orientação EXIF 5–8 troca largura e altura
  const rotated = (info.orientation ?? 1) >= 5;
  const width = rotated ? info.height : info.width;
  const height = rotated ? info.width : info.height;
  await writeFile(path.join(dir, `${opts.baseName}.${ext}`), input);

  const widths: number[] = WIDTHS.filter((w) => w <= width);
  if (widths.length === 0) widths.push(width);

  await Promise.all(
    widths.flatMap((w) => [
      base.clone().resize({ width: w }).webp({ quality: 78 }).toFile(path.join(dir, `${opts.baseName}-${w}.webp`)),
      base.clone().resize({ width: w }).avif({ quality: 55, effort: 4 }).toFile(path.join(dir, `${opts.baseName}-${w}.avif`)),
    ])
  );

  await base
    .clone()
    .resize({ width: 1200, height: 630, fit: "cover", position: "attention" })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(path.join(dir, `${opts.baseName}-og.jpg`));

  const publicDir = `${PUBLIC_PREFIX}${opts.subdir}`.replace(/\/+/g, "/");
  const meta: MediaMeta = {
    src: `${publicDir}/${opts.baseName}.${ext}`,
    width,
    height,
    widths,
    formats: ["avif", "webp"],
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

export function variantUrl(meta: MediaMeta, width: number, format: "avif" | "webp"): string {
  return meta.src.replace(/\.[a-z0-9]+$/i, `-${width}.${format}`);
}

export function srcset(meta: MediaMeta, format: "avif" | "webp"): string {
  return meta.widths.map((w) => `${variantUrl(meta, w, format)} ${w}w`).join(", ");
}
