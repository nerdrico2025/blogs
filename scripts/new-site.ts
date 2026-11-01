/**
 * Cria um blog novo em sites/<nome>/ a partir do blog de exemplo.
 *
 * Uso: npm run new-site -- <nome> --name "Nome do Blog" --domain dominio.com.br [--tagline "..."] [--accent "#1363df"]
 *        [--categories "Nome|slug|Descrição;Outra|outra|Descrição"] [--categories-file categorias.json]
 *   <nome>  pasta e valor da variável SITE (letras minúsculas, números e hífen)
 * As categorias vão para sites/<nome>/settings.json, com ids estáveis a partir de 2.
 * O arquivo JSON é uma lista de { "name", "slug", "description" }.
 */
import { cp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { generateBrand } from "./lib/brand.ts";
import type { Settings } from "../shared/settings.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    domain: { type: "string" },
    tagline: { type: "string" },
    accent: { type: "string" },
    categories: { type: "string" },
    "categories-file": { type: "string" },
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

type NewCategory = { name: string; slug: string; description: string };
let categories: NewCategory[] | null = null;
if (values["categories-file"]) categories = JSON.parse(await readFile(values["categories-file"], "utf8")) as NewCategory[];
else if (values.categories) {
  categories = values.categories.split(";").filter((c) => c.trim()).map((c) => {
    const [catName = "", slug = "", ...description] = c.split("|").map((p) => p.trim());
    return { name: catName, slug, description: description.join("|") };
  });
}
if (categories) {
  const slugs = new Set<string>();
  for (const c of categories) {
    if (!c.name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.slug) || slugs.has(c.slug)) fail(`categoria inválida ou repetida: ${c.name}|${c.slug} (slug em minúsculas, sem acento).`);
    slugs.add(c.slug);
  }
  if (categories.length === 0) fail("--categories está vazio.");
}

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
  ["authorBox", "      ", "caixa do autor: aparece ao cadastrar na aba Autor do painel"],
] as const) {
  replace(new RegExp(`(${block}: \\{\\n${indent})enabled: true,`), `$1enabled: false, // TODO: ${note}`);
}
// Blocos de viagem do modelo: o blog novo nasce neutro, com tudo desligado, e preenche na aba Home do painel
replace(/(ticker: \{\n\s+enabled: )true,\n\s+separator: "✈",/, "$1false,");
replace(/tools: \{\n[\s\S]*?\n    \},/, `tools: {
      enabled: false,
      icon: "🧰",
      title: "Recursos",
      text: "Ferramentas que recomendamos.",
      items: [],
      button: { label: "Ver todos os recursos", href: "/sobre/" },
    },`);
replace(/callout: \{\n[\s\S]*?\n    \},/, `callout: {
      enabled: false,
      icon: "📘",
      kicker: "Guias completos",
      title: "Guias",
      text: "Materiais completos para aprofundar o assunto.",
      button: { label: "Conhecer os guias", href: "/sobre/" },
    },`);
replace(/placeholder: "[^"]*"/, `placeholder: "O que você procura?"`);
replace(/(footer: \{\n\s+text: )"[^"]*",/, `$1${q(`${name} é um blog independente. Conteúdo informativo; confirme preços e regras com as empresas antes de comprar.`)},`);
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

// settings.json inicial: é o ponto de partida até o /admin gravar o /data/settings.json
const settings: Settings = { brand: { name, colors: { primary: accent } }, tagline };
if (categories) {
  settings.categories = categories.map((c, i) => ({ id: i + 2, ...c }));
  settings.nextCategoryId = categories.length + 2;
}
await writeFile(path.join(target, "settings.json"), JSON.stringify(settings, null, 2) + "\n");

console.log(`
Blog criado em sites/${id}/

Revise antes do deploy:
  - sites/${id}/settings.json    categorias (ids fixos!), nome e cor principal
  - sites/${id}/site.config.ts   categorias de reserva, autor, redes sociais, sidebar, rodapé e os TODOs
  - sites/${id}/public/brand/    logo, favicon, imagens de compartilhamento e banners (gerados provisoriamente)
  - sites/${id}/pages/           Sobre, Contato e textos legais (revisão jurídica)

Testar localmente:
  SITE=${id} npm run dev

Próximos passos (docs/deploy-easypanel.md, "Receita para adicionar um novo blog"):
  1. git add sites/${id} && git commit -m "Adiciona o blog ${id}" && git push
  2. No Easypanel: novo serviço App com SITE=${id} e SITE_URL=https://${domain}
`);
