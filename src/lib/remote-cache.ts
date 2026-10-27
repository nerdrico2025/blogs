/**
 * Dados externos buscados no build (cotação, último vídeo), com cache em disco.
 * Se a fonte falhar, usa o cache vencido; sem cache, devolve null e o chamador usa o padrão da config.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { localDataDir } from "./site-id.ts";

const DIR = path.resolve(process.env.BUILD_CACHE_DIR ?? path.join(localDataDir(), "data", "build-cache"));

interface Entry<T> {
  at: number;
  value: T;
}

export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T | null> {
  const file = path.join(DIR, `${key}.json`);
  let entry: Entry<T> | null = null;
  try {
    entry = JSON.parse(await readFile(file, "utf8")) as Entry<T>;
  } catch {}
  if (entry && Date.now() - entry.at < ttlMs) return entry.value;
  try {
    const value = await fetcher();
    await mkdir(DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ at: Date.now(), value } satisfies Entry<T>));
    return value;
  } catch (err) {
    console.warn(`[cache] ${key}: ${(err as Error).message}${entry ? " (usando cache antigo)" : ""}`);
    return entry?.value ?? null;
  }
}

export async function fetchText(url: string, timeoutMs = 5000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "blog-build/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}
