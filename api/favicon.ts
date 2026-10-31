/**
 * Gera os ícones do blog a partir da imagem enviada no painel. A entrada pode ser PNG, JPG, WebP ou SVG;
 * a saída é sempre ICO, PNG e (só se a entrada for SVG) o próprio SVG: nunca WebP.
 */
import { createHash } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export const FAVICON_ICO = "favicon.ico";
export const APPLE_TOUCH_ICON = "apple-touch-icon.png";
export const FAVICON_SVG = "favicon.svg";
const PNG_SIZES = [32, 192, 512];
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/** ICO com um único PNG dentro: formato aceito por todos os navegadores atuais. */
export function pngToIco(png: Buffer, size: number): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // tipo: ícone
  header.writeUInt16LE(1, 4); // quantidade de imagens
  header.writeUInt8(size, 6);
  header.writeUInt8(size, 7);
  header.writeUInt16LE(1, 10); // planos
  header.writeUInt16LE(32, 12); // bits por pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // posição do PNG
  return Buffer.concat([header, png]);
}

/** Grava em arquivo temporário e renomeia: quem pedir o ícone durante a troca nunca recebe um arquivo pela metade. */
async function writeAtomic(file: string, data: Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** Gera todos os ícones na memória antes de gravar: imagem ilegível não deixa um conjunto incompleto. */
export async function writeFavicons(input: Buffer, dir: string): Promise<{ version: string; svg: boolean }> {
  const meta = await sharp(input, { failOn: "error", limitInputPixels: 50_000_000 }).metadata();
  const svg = meta.format === "svg";
  // SVG é rasterizado no tamanho do desenho: sem isso, um viewBox de 32 ficaria borrado em 512 px
  const density = svg ? Math.max(1, Math.ceil((72 * 1024) / Math.max(meta.width ?? 1024, meta.height ?? 1024))) : undefined;
  const source = () => sharp(input, { failOn: "error", limitInputPixels: 50_000_000, ...(density ? { density } : {}) }).rotate();
  const png = (size: number) => source().resize(size, size, { fit: "contain", background: TRANSPARENT }).png().toBuffer();

  const files = new Map<string, Buffer>();
  files.set(FAVICON_ICO, pngToIco(await png(48), 48));
  for (const size of PNG_SIZES) files.set(`favicon-${size}.png`, await png(size));
  // O iOS pinta de preto o que for transparente
  files.set(APPLE_TOUCH_ICON, await source().resize(180, 180, { fit: "contain", background: WHITE }).flatten({ background: WHITE }).png().toBuffer());
  if (svg) files.set(FAVICON_SVG, input);

  for (const [name, data] of files) await writeAtomic(path.join(dir, name), data);
  if (!svg) await rm(path.join(dir, FAVICON_SVG), { force: true });
  return { version: createHash("sha256").update(input).digest("hex").slice(0, 10), svg };
}
