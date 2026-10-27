/**
 * Cria um blog novo em sites/<nome>/ a partir do blog de exemplo.
 *
 * Uso: npm run new-site -- <nome> --name "Nome do Blog" --domain dominio.com.br [--tagline "..."] [--accent "#1363df"]
 *   <nome>  pasta e valor da variável SITE (letras minúsculas, números e hífen)
 */
import { cp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { generateBrand } from "./lib/brand.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    domain: { type: "string" },
    tagline: { type: "string" },
    accent: { type: "string" },
  },
});

const id = positionals[0];
function fail(msg: string): never {
  console.error(`Erro: ${msg}\nUso: npm run new-site -- <nome> --name "Nome do Blog" --domain dominio.com.br [--tagline "..."] [--accent "#1363df"]`);
  process.exit(1);
}
if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) fail("informe o nome da pasta (letras minúsculas, números e hífen).");
if (!values.name) fail("informe --name.");
if (!values.domain) fail("informe --domain.");
const domain = values.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) fail(`domínio inválido: ${values.domain}`);
const accent = values.accent ?? "#1363df";
if (!/^#[0-9a-f]{6}$/i.test(accent)) fail("--accent precisa ser uma cor como #1363df.");

const model = path.resolve("sites/exemplo");
const target = path.resolve("sites", id);
if (existsSync(target)) fail(`sites/${id} já existe.`);

const name = values.name;
const tagline = values.tagline ?? "Viagens bem planejadas, sem complicação";

await cp(path.join(model, "pages"), path.join(target, "pages"), { recursive: true });
await cp(path.join(model, "redirects.txt"), path.join(target, "redirects.txt"));
const brand = await generateBrand(path.join(target, "public", "brand"), { name, tagline, accent });

const q = (s: string) => JSON.stringify(s);
let config = await readFile(path.join(model, "site.config.ts"), "utf8");
const replace = (from: string | RegExp, to: string) => {
  const before = config;
  config = config.replace(from, to);
  if (before === config) console.warn(`aviso: trecho não encontrado no modelo: ${from}`);
};
replace(/^\/\*\*[\s\S]*?\*\/\n/, `/**
 * Configuração do blog "${name}" (pasta sites/${id}, variável SITE=${id}).
 * Gerada por \`npm run new-site\` a partir de sites/exemplo. Revise os itens marcados com TODO.
 */
`);
replace(/name: "Rota Leve",/, `name: ${q(name)},`);
replace(/tagline: "[^"]*",/, `tagline: ${q(tagline)},`);
replace(/url: "https:\/\/rotaleve\.example",/, `url: ${q(`https://${domain}`)},`);
replace(/logo: \{ src: "\/brand\/logo\.svg", width: \d+, height: \d+, alt: "Rota Leve" \},/, `logo: { src: "/brand/logo.svg", width: ${brand.logoWidth}, height: ${brand.logoHeight}, alt: ${q(name)} },`);
if (values.accent) replace(/accent: "#1363df",/, `accent: ${q(accent)},`);
replace(/"clara-menezes": \{\n\s+name: "Clara Menezes",\n\s+role: "[^"]*",\n\s+bio: "[^"]*",\n\s+avatar: "\/brand\/autora\.webp",/, `autor: {
      // TODO: nome, função, bio e foto (public/brand/autor.webp) de quem assina os posts
      name: ${q(`Equipe ${name}`)},
      role: "Equipe editorial",
      bio: ${q(`Equipe do ${name}. TODO: escreva uma bio curta.`)},
      avatar: "/brand/autor.webp",
      links: {}, // TODO: { youtube: "https://www.youtube.com/@...", instagram: "..." }`);
replace(/\n\s+links: \{ youtube: "https:\/\/www\.youtube\.com\/@rotaleve-exemplo", instagram: "[^"]*" \},/, "");
replace(/social: \{\n[^}]*\},/, `social: {}, // TODO: { youtube: "https://www.youtube.com/@...", instagram: "https://www.instagram.com/..." }`);
// Blocos que apontam para links de exemplo nascem desligados (ligue quando tiver os links reais)
for (const [block, indent, note] of [
  ["banner", "      ", "banner da home: imagem e link do anunciante"],
  ["newsletter", "      ", "newsletter: link de inscrição"],
  ["youtube", "      ", "último vídeo: preencha channelId"],
  ["affiliate", "      ", "banner lateral: imagem e link do afiliado"],
  ["cta", "      ", "caixa no meio do artigo: título, texto e link"],
  ["club", "        ", "clube/assinatura: link"],
] as const) {
  replace(new RegExp(`(${block}: \\{\\n${indent})enabled: true,`), `$1enabled: false, // TODO: ${note}`);
}
replace(/defaultAuthor: "clara-menezes",/, `defaultAuthor: "autor",`);
config = config
  .replaceAll("Rota Leve", name)
  .replaceAll("rotaleve.example", domain)
  .replaceAll("rotaleve-exemplo", id)
  .replaceAll("utm_source=rotaleve", `utm_source=${id}`);
replace(/contact: \{ email: "[^"]*" \},/, `contact: { email: ${q(`contato@${domain}`)} }, // TODO: confirme o e-mail`);
replace(/channelId: "",/, `channelId: "", // TODO: id do canal (UC...) para mostrar o último vídeo`);
replace(/analytics: \{ gaId: "", adsenseClient: "" \},/, `analytics: { gaId: "", adsenseClient: "" }, // TODO: IDs do Google Analytics e do AdSense`);
await writeFile(path.join(target, "site.config.ts"), config);

console.log(`
Blog criado em sites/${id}/

Revise antes do deploy:
  - sites/${id}/site.config.ts   categorias (ids fixos!), autor, redes sociais, sidebar, rodapé e os TODOs
  - sites/${id}/public/brand/    logo, favicon, imagens de compartilhamento e banners (gerados provisoriamente)
  - sites/${id}/pages/           Sobre, Contato e textos legais (revisão jurídica)

Testar localmente:
  SITE=${id} npm run dev

Próximos passos (docs/deploy-easypanel.md, "Receita para adicionar um novo blog"):
  1. git add sites/${id} && git commit -m "Adiciona o blog ${id}" && git push
  2. No Easypanel: novo serviço App com SITE=${id} e SITE_URL=https://${domain}
`);
