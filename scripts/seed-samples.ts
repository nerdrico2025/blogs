/**
 * Copia os posts fictícios de exemplo (sites/exemplo/sample-content/posts) para o CONTENT_DIR
 * e gera as imagens deles (ilustrações em SVG rasterizadas com sharp) no UPLOADS_DIR.
 * Só copia se o CONTENT_DIR estiver vazio, a não ser com --force.
 *
 * Uso: npm run seed            (local: .local/<SITE>/)
 *      no container: npm run seed   (usa CONTENT_DIR e UPLOADS_DIR do ambiente, em /data)
 */
import "./lib/drop-root.ts";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { processImage } from "../shared/media.ts";
import { localDataDir } from "../src/lib/site-id.ts";

interface Scene {
  sky: [string, string];
  sun: string;
  layers: string[];
  water?: string;
  plane?: boolean;
  city?: string;
  seed: number;
}

function rand(seed: number) {
  let s = seed;
  return () => ((s = (s * 9301 + 49297) % 233280) / 233280);
}

function ridge(r: () => number, baseY: number, amp: number, color: string, w = 1920, h = 1080): string {
  const pts: string[] = [`0,${h}`];
  const steps = 9;
  for (let i = 0; i <= steps; i++) {
    const x = (w / steps) * i;
    const y = baseY - r() * amp;
    pts.push(`${x.toFixed(0)},${y.toFixed(0)}`);
  }
  pts.push(`${w},${h}`);
  return `<polygon points="${pts.join(" ")}" fill="${color}"/>`;
}

function citySkyline(r: () => number, color: string): string {
  let x = 0;
  let out = "";
  while (x < 1920) {
    const bw = 50 + r() * 90;
    const bh = 120 + r() * 260;
    out += `<rect x="${x.toFixed(0)}" y="${(820 - bh).toFixed(0)}" width="${bw.toFixed(0)}" height="${(bh + 260).toFixed(0)}" fill="${color}"/>`;
    if (r() > 0.6) out += `<polygon points="${x.toFixed(0)},${(820 - bh).toFixed(0)} ${(x + bw / 2).toFixed(0)},${(760 - bh).toFixed(0)} ${(x + bw).toFixed(0)},${(820 - bh).toFixed(0)}" fill="${color}"/>`;
    x += bw + 6 + r() * 20;
  }
  return out;
}

function sceneSvg(s: Scene): string {
  const r = rand(s.seed);
  const sunX = 400 + r() * 1100;
  const sunY = 260 + r() * 200;
  const clouds = Array.from({ length: 4 }, () => {
    const cx = r() * 1920;
    const cy = 120 + r() * 260;
    return `<g fill="#ffffff" opacity="0.55"><ellipse cx="${cx}" cy="${cy}" rx="120" ry="34"/><ellipse cx="${cx + 70}" cy="${cy - 22}" rx="80" ry="32"/><ellipse cx="${cx - 60}" cy="${cy - 10}" rx="70" ry="26"/></g>`;
  }).join("");
  const layers = s.layers.map((c, i) => ridge(r, 620 + i * 110, 220 - i * 40, c)).join("");
  const plane = s.plane
    ? `<g transform="translate(1250 300) rotate(-14)" fill="#ffffff"><rect x="-150" y="-14" width="300" height="28" rx="14"/><polygon points="-30,-6 40,-6 -60,-120 -95,-120"/><polygon points="-30,6 40,6 -60,120 -95,120"/><polygon points="-150,-8 -110,-8 -150,-60 -170,-60"/></g>`
    : "";
  const water = s.water ? `<rect x="0" y="880" width="1920" height="200" fill="${s.water}"/><g stroke="#ffffff" stroke-opacity="0.35" stroke-width="4">${Array.from({ length: 8 }, () => { const x = r() * 1800; const y = 910 + r() * 150; return `<line x1="${x}" y1="${y}" x2="${x + 80}" y2="${y}"/>`; }).join("")}</g>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.sky[0]}"/><stop offset="1" stop-color="${s.sky[1]}"/></linearGradient></defs>
  <rect width="1920" height="1080" fill="url(#sky)"/>
  <circle cx="${sunX}" cy="${sunY}" r="120" fill="${s.sun}"/>
  ${clouds}${plane}${layers}${s.city ? citySkyline(r, s.city) : ""}${water}
</svg>`;
}

const posts: { file: string; alt: string; scene: Scene }[] = [
  { file: "2026/10/roteiro-lisboa-4-dias", alt: "Ilustração de colinas de uma cidade à beira do rio ao pôr do sol", scene: { sky: ["#ffb37a", "#ffe3c4"], sun: "#fff4d6", layers: ["#c9785a", "#9c5443"], city: "#6e3a33", water: "#4b6c8f", seed: 11 } },
  { file: "2026/10/lisboa-miradouro", alt: "Ilustração de um mirante com vista para telhados e o rio", scene: { sky: ["#8ec5ff", "#dff0ff"], sun: "#fff6c9", layers: ["#7fb48f", "#4f8a68"], city: "#b45f3e", water: "#3a77b5", seed: 23 } },
  { file: "2026/10/lisboa-bairro", alt: "Ilustração de ruas estreitas em um bairro histórico", scene: { sky: ["#f6c6d0", "#fdeef1"], sun: "#ffffff", layers: ["#d4a373", "#a26b45"], city: "#7a4b35", seed: 37 } },
  { file: "2026/10/roteiro-porto-2-dias", alt: "Ilustração de uma cidade de casas coloridas às margens de um rio", scene: { sky: ["#a7c7e7", "#f1f7fd"], sun: "#fff2c2", layers: ["#c98f6b", "#9a6249"], city: "#7b3f2e", water: "#2f5f86", seed: 61 } },
  { file: "2026/10/mala-de-mao-10-dias", alt: "Ilustração de montanhas azuladas e um céu limpo", scene: { sky: ["#5aa9e6", "#c9e7ff"], sun: "#fffbe0", layers: ["#7aa6c2", "#4f7d9c", "#2f5875"], seed: 5 } },
  { file: "2026/10/mala-organizada", alt: "Ilustração de paisagem de montanha ao amanhecer", scene: { sky: ["#c3b1e1", "#f3eafc"], sun: "#ffe8a3", layers: ["#9a86c4", "#6b5b9a"], seed: 41 } },
  { file: "2026/10/cartao-ou-dinheiro-no-exterior", alt: "Ilustração de uma cidade moderna ao entardecer", scene: { sky: ["#264b7a", "#f2a65a"], sun: "#ffd27a", layers: ["#2f3e5c"], city: "#1d2840", seed: 17 } },
  { file: "2026/10/como-escolher-hospedagem", alt: "Ilustração de colinas verdes com um lago", scene: { sky: ["#9ed8db", "#e9fbfb"], sun: "#ffffff", layers: ["#7fbf8e", "#4f9a6a", "#2f7a52"], water: "#3f8fa3", seed: 29 } },
  { file: "2026/10/quando-comprar-passagem-barata", alt: "Ilustração de um avião cruzando o céu sobre as montanhas", scene: { sky: ["#3d8bfd", "#bfe0ff"], sun: "#fff5cc", layers: ["#8fb6d9", "#5b88b3"], plane: true, seed: 7 } },
  { file: "2026/09/checklist-viagem-internacional", alt: "Ilustração de dunas e um céu alaranjado", scene: { sky: ["#f8a35c", "#fde2c0"], sun: "#fff1d0", layers: ["#e6a76d", "#c98549", "#a8672f"], seed: 53 } },
];

async function svgToBuffer(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  const force = process.argv.includes("--force");
  const source = path.resolve("sites/exemplo/sample-content/posts");
  const contentDir = path.resolve(process.env.CONTENT_DIR ?? path.join(localDataDir(), "content/posts"));
  await mkdir(contentDir, { recursive: true });
  const existing = (await readdir(contentDir)).filter((f) => f.endsWith(".md"));
  if (existing.length > 0 && !force) {
    console.log(`${contentDir} já tem ${existing.length} posts; nada copiado (use --force para copiar mesmo assim).`);
    return;
  }
  for (const f of (await readdir(source)).filter((f) => f.endsWith(".md"))) await copyFile(path.join(source, f), path.join(contentDir, f));
  console.log(`posts de exemplo copiados para ${contentDir}`);

  for (const p of posts) {
    await processImage(await svgToBuffer(sceneSvg(p.scene)), { subdir: path.dirname(p.file), baseName: path.basename(p.file), alt: p.alt });
    console.log("imagem ok", p.file);
  }
  console.log("Pronto. Gere um build para publicar (no container: curl -X POST localhost:$PORT/internal/rebuild).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
