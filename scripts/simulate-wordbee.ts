/**
 * Simula o Wordbee publicando no blog, com as mesmas requisições do
 * packages/shared/src/wordpress/client.ts dele (caminhos, cabeçalhos e corpo).
 *
 * Uso: node scripts/simulate-wordbee.ts <url-do-site> <usuario> "<senha de aplicação>" [imagem.png]
 * Sem imagem, gera uma PNG 1536×1024 parecida com as de IA.
 */
import { readFile } from "node:fs/promises";
import sharp from "sharp";

const [base, user, password, imagePath] = process.argv.slice(2);
if (!base || !user || !password) {
  console.error('Uso: node scripts/simulate-wordbee.ts <url> <usuario> "<senha>" [imagem.png]');
  process.exit(1);
}

const restBase = `${new URL(base).origin}${new URL(base).pathname.replace(/\/$/, "")}/wp-json/wp/v2`;
const headers = {
  Authorization: "Basic " + Buffer.from(`${user}:${password}`).toString("base64"),
  "User-Agent": "WordbeeClone/1.0 (+uso-pessoal)",
};

async function call(path: string, init: RequestInit = {}, timeoutMs = 15_000) {
  const started = performance.now();
  const res = await fetch(restBase + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
  const ms = Math.round(performance.now() - started);
  const body = await res.text();
  console.log(`${init.method ?? "GET"} ${path} → ${res.status} em ${ms} ms`);
  if (!res.ok) throw new Error(body.slice(0, 200));
  return JSON.parse(body);
}

async function aiLikeImage(): Promise<Buffer> {
  const w = 1536;
  const h = 1024;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i += 3) {
    const x = (i / 3) % w;
    const y = Math.floor(i / 3 / w);
    raw[i] = (x * 255) / w + Math.random() * 40;
    raw[i + 1] = (y * 255) / h + Math.random() * 40;
    raw[i + 2] = 160 + Math.random() * 60;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** Em teste local o domínio do site.config.ts não resolve: busca pelo endereço informado. */
const local = (u: string) => {
  const target = new URL(u);
  const b = new URL(base);
  target.protocol = b.protocol;
  target.host = b.host;
  return target.toString();
};

const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, "");
const slug = `teste-wordbee-${stamp}`;

// 1. Testar conexão
const me = await call("/users/me?context=edit");
if (!(me.roles ?? []).includes("administrator")) throw new Error("usuário sem papel administrator");

// 2. Categorias
const cats = await call("/categories?per_page=100&orderby=name&order=asc");
const category = cats[0];
console.log(`  categorias: ${cats.map((c: { id: number; name: string }) => `${c.id}=${c.name}`).join(", ")}`);

// 3. Imagem destacada (corpo binário, como o uploadMedia do Wordbee)
const image = imagePath ? await readFile(imagePath) : await aiLikeImage();
console.log(`  imagem: ${(image.length / 1024 / 1024).toFixed(1)} MB`);
const media = await call(
  "/media",
  { method: "POST", headers: { "Content-Type": "image/png", "Content-Disposition": `attachment; filename="${slug}.png"` }, body: new Uint8Array(image) },
  30_000
);
const imgRes = await fetch(local(media.source_url));
console.log(`  source_url ${media.source_url} → ${imgRes.status} (${imgRes.headers.get("content-type")})`);

// 4. Post (createPost do Wordbee)
const contentHtml = `<p>Este é um artigo de teste publicado pela simulação do Wordbee.</p>
<h2>Primeira seção</h2><p>Texto com <strong>negrito</strong> e <em>itálico</em>.</p>
<h2>Segunda seção</h2><ul><li>Item um</li><li>Item dois</li></ul>
<h2>Terceira seção</h2><blockquote><p>Uma citação que vira caixa de destaque.</p></blockquote>
<h2>Perguntas frequentes</h2><h3>Funciona?</h3><p>Sim, este é o teste.</p><h3>Precisa de ação manual?</h3><p>Não.</p>`;
const body = {
  title: `Teste de publicação ${stamp}`,
  content: contentHtml,
  status: "publish",
  excerpt: "Artigo de teste publicado pela simulação do Wordbee.",
  slug,
  categories: [category.id],
  featured_media: media.id,
};
const post = await call("/posts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
console.log(`  post ${post.id}: ${post.link}`);

// 5. Retry (o Wordbee reenvia após timeout): não pode duplicar
const again = await call("/posts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
console.log(`  retry → id ${again.id} ${again.id === post.id ? "(mesmo post, ok)" : "(DUPLICOU!)"}`);

// 6. Espera a página aparecer
const t0 = Date.now();
for (;;) {
  const res = await fetch(local(post.link)).catch(() => null);
  if (res?.ok) {
    console.log(`  página no ar em ${((Date.now() - t0) / 1000).toFixed(1)} s depois da resposta do POST`);
    break;
  }
  if (Date.now() - t0 > 120_000) throw new Error("a página não apareceu em 2 minutos");
  await new Promise((r) => setTimeout(r, 1000));
}
