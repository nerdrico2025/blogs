/**
 * Apoio à exclusão de artigos: descobre os arquivos de cada imagem e cuida da lixeira
 * (<lixeira>/<AAAA-MM-DD>-<slug>/), que fica fora de toda pasta servida ao público.
 */
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { PUBLIC_PREFIX, variantUrl, type MediaMeta } from "../shared/media.ts";

const REFERENCE = /\/wp-content\/uploads\/([^\s)"'<>?#\\]+)/g;

/** Caminhos relativos a uploads citados num texto (capa, corpo, com ou sem domínio). */
export function uploadRefs(text: string): string[] {
  return [...new Set([...text.matchAll(REFERENCE)].map((m) => m[1]!))].filter((rel) => !rel.split("/").includes(".."));
}

export interface ImageFiles {
  /** Caminho sem extensão, ou o próprio arquivo se a imagem não tem .json. */
  key: string;
  files: string[];
}

/**
 * A imagem a que uma referência pertence. Os arquivos vêm do .json, nunca de um "nome-*":
 * assim, apagar "foto" não leva junto uma imagem diferente chamada "foto-2".
 */
export function resolveImage(uploadsDir: string, rel: string): ImageFiles | null {
  const stem = rel.replace(/\.[a-z0-9]+$/i, "");
  for (const key of [stem, stem.replace(/-(\d+|og)$/, "")]) {
    const json = path.join(uploadsDir, `${key}.json`);
    if (!existsSync(json)) continue;
    const meta = JSON.parse(readFileSync(json, "utf8")) as MediaMeta;
    const urls = [meta.src, meta.jpeg, meta.og, ...meta.formats.flatMap((f) => meta.widths.map((w) => variantUrl(meta, w, f)))];
    const files = urls.flatMap((u) => (u?.startsWith(PUBLIC_PREFIX) ? [u.slice(PUBLIC_PREFIX.length)] : []));
    return { key, files: [...new Set([...files, `${key}.json`])].filter((f) => !f.split("/").includes("..")) };
  }
  return existsSync(path.join(uploadsDir, rel)) ? { key: rel, files: [rel] } : null;
}

/** Pasta ainda não usada: duas exclusões do mesmo slug no mesmo dia não se misturam. */
export async function trashFolder(trashDir: string, slug: string, now = new Date()): Promise<string> {
  await mkdir(trashDir, { recursive: true });
  const base = `${now.toISOString().slice(0, 10)}-${slug}`;
  let name = base;
  for (let i = 2; existsSync(path.join(trashDir, name)); i++) name = `${base}-${i}`;
  return path.join(trashDir, name);
}

/**
 * Apaga da lixeira o que passou do prazo. A data vem do nome da pasta, e só entram
 * pastas de verdade no formato da lixeira: o resto é ignorado. 0 dias desliga a limpeza.
 */
export async function cleanTrash(trashDir: string, retentionDays: number, now = new Date()): Promise<number> {
  if (retentionDays <= 0 || !existsSync(trashDir)) return 0;
  const limit = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;
  for (const name of await readdir(trashDir)) {
    const date = name.match(/^(\d{4}-\d{2}-\d{2})-./)?.[1];
    if (!date) continue;
    const time = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(time) || time >= limit) continue;
    const full = path.join(trashDir, name);
    if (!(await lstat(full)).isDirectory()) continue;
    await rm(full, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
