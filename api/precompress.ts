/** Gera .br e .gz ao lado dos arquivos de texto do build, servidos direto pelo api/static.ts. */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const br = promisify(brotliCompress);
const gz = promisify(gzip);
const EXT = new Set([".html", ".css", ".js", ".mjs", ".json", ".xml", ".svg", ".txt", ".webmanifest"]);

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && EXT.has(path.extname(entry.name))) yield p;
  }
}

export async function precompress(dir: string): Promise<number> {
  let count = 0;
  for await (const file of walk(dir)) {
    if ((await stat(file)).size < 1024) continue;
    const data = await readFile(file);
    const [b, g] = await Promise.all([
      br(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
      gz(data, { level: 9 }),
    ]);
    await Promise.all([writeFile(`${file}.br`, b), writeFile(`${file}.gz`, g)]);
    count++;
  }
  return count;
}
