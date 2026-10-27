/**
 * Gera uma identidade visual provisória (logo, favicon, imagens de compartilhamento e banners)
 * a partir do nome e da cor de destaque. Substitua pelos arquivos definitivos quando tiver.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = "font-family='Helvetica, Arial, sans-serif'";

export interface BrandInput {
  name: string;
  tagline: string;
  accent: string;
}

export interface BrandResult {
  logoWidth: number;
  logoHeight: number;
}

export async function generateBrand(dir: string, b: BrandInput): Promise<BrandResult> {
  await mkdir(dir, { recursive: true });
  const name = esc(b.name);
  const initial = esc(b.name.trim().charAt(0).toUpperCase() || "B");
  const logoWidth = Math.round(52 + b.name.length * 11.5);

  await writeFile(
    path.join(dir, "logo.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${logoWidth}" height="40" viewBox="0 0 ${logoWidth} 40"><circle cx="20" cy="20" r="18" fill="${b.accent}"/><text x="20" y="27" text-anchor="middle" ${FONT} font-size="20" font-weight="800" fill="#fff">${initial}</text><text x="46" y="27" ${FONT} font-size="20" font-weight="800" fill="#111">${name}</text></svg>`
  );
  await writeFile(
    path.join(dir, "favicon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="${b.accent}"/><text x="16" y="22" text-anchor="middle" ${FONT} font-size="17" font-weight="800" fill="#fff">${initial}</text></svg>`
  );
  const square = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#fff"/><circle cx="256" cy="256" r="220" fill="${b.accent}"/><text x="256" y="330" text-anchor="middle" ${FONT} font-size="220" font-weight="800" fill="#fff">${initial}</text></svg>`;
  await sharp(Buffer.from(square)).png().toFile(path.join(dir, "logo-512.png"));

  const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${b.accent}"/><stop offset="1" stop-color="#0f172a"/></linearGradient></defs><rect width="1200" height="630" fill="url(#g)"/><text x="100" y="300" ${FONT} font-size="84" font-weight="800" fill="#fff">${name}</text><text x="100" y="390" ${FONT} font-size="38" fill="#e2e8f0">${esc(b.tagline)}</text></svg>`;
  await sharp(Buffer.from(og)).jpeg({ quality: 85, mozjpeg: true }).toFile(path.join(dir, "og-default.jpg"));

  const avatar = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360"><rect width="360" height="360" fill="#e2e8f0"/><circle cx="180" cy="145" r="68" fill="#94a3b8"/><path d="M60 360 Q180 215 300 360 Z" fill="${b.accent}"/></svg>`;
  await sharp(Buffer.from(avatar)).webp({ quality: 80 }).toFile(path.join(dir, "autor.webp"));

  const thumb = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="${b.accent}"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><text x="40" y="190" ${FONT} font-size="44" font-weight="800" fill="#fff">${name}</text></svg>`;
  await sharp(Buffer.from(thumb)).webp({ quality: 78 }).toFile(path.join(dir, "youtube-thumb.webp"));

  const bannerHome = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="200"><rect width="1200" height="200" fill="#0f172a"/><text x="60" y="95" ${FONT} font-size="40" font-weight="800" fill="#fff">Espaço publicitário</text><text x="60" y="140" ${FONT} font-size="22" fill="#cbd5e1">Banner provisório (1200×200) · troque em public/brand/banner-home.webp</text></svg>`;
  await sharp(Buffer.from(bannerHome)).webp({ quality: 80 }).toFile(path.join(dir, "banner-home.webp"));

  const side = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1200"><rect width="600" height="1200" fill="${b.accent}"/><text x="60" y="300" ${FONT} font-size="60" font-weight="800" fill="#fff">Espaço</text><text x="60" y="375" ${FONT} font-size="60" font-weight="800" fill="#fff">publicitário</text><text x="60" y="1120" ${FONT} font-size="24" fill="#f1f5f9">Banner provisório (300×600)</text></svg>`;
  await sharp(Buffer.from(side)).resize(300).webp({ quality: 80 }).toFile(path.join(dir, "banner-lateral.webp"));
  await sharp(Buffer.from(side)).webp({ quality: 78 }).toFile(path.join(dir, "banner-lateral@2x.webp"));

  return { logoWidth, logoHeight: 40 };
}
