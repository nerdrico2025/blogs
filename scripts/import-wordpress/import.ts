/**
 * Importa os posts publicados de um site WordPress para um blog deste repositório, pelo mesmo
 * caminho do Wordbee: a API compatível com WordPress do blog (POST /media e /posts).
 * Ver scripts/import-wordpress/README.md.
 *
 *   node scripts/import-wordpress/import.ts --from https://site-antigo.com.br --blog <nome> \
 *     --categories categorias.json [--xml export.xml] [--api https://blog] [--dry-run] [--limit N]
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { BlogApi, type BlogCategory, type BlogMedia } from "./blog.ts";
import { finishHtml, imageKey, originalCandidates, prepareHtml, type ImageRef } from "./html.ts";
import { CategoryMapper, parseCategoryMap, writeRedirects } from "./mapping.ts";
import { fetchWithRetry, pathOf, readRest, readXml, type SourcePost, type SourceSite } from "./source.ts";
import { runSuggest } from "./suggest.ts";

const HELP = `Uso: node scripts/import-wordpress/import.ts --from <url> --blog <nome> --categories <arquivo> [opções]

  --from <url>          site WordPress de origem (lê /wp-json/wp/v2/posts?_embed)
  --xml <arquivo>       exportação XML do WordPress: usada se a REST API falhar (ou sozinha, sem --from)
  --blog <nome>         blog de destino (pasta sites/<nome>)
  --categories <arq>    mapeamento de categorias de/para (JSON ou "antigo => novo" por linha)
  --api <url>           endereço do blog que recebe (padrão: o url do site.config.ts do blog)
  --user, --password    usuário e senha de aplicação do Wordbee no blog
                        (ou IMPORT_BLOG_USER e IMPORT_BLOG_PASSWORD)
  --redirects <arq>     arquivo de redirects (padrão: sites/<nome>/redirects.txt)
  --old-domain <host>   outro domínio do site antigo, para reescrever links (repetível)
  --dry-run             não grava nada: mostra o que faria
  --limit <N>           só os N posts mais recentes
  --slug <a,b>          só estes posts (slugs da origem)
  --since <AAAA-MM-DD>  ignora os posts da origem publicados antes desta data
  --exclude <arquivo>   ignora os slugs listados (um por linha, # comenta)
  --verbose             mostra o começo do HTML limpo de cada post
  --suggest-categories  só sugere o mapeamento de categorias (lê a origem e o site.config.ts do blog,
                        grava em --categories ou sites/<nome>/categorias-wordpress.txt; se o arquivo
                        existir, grava <arquivo>.sugerido). Não importa nada nem chama o destino`;

const { values: args } = parseArgs({
  options: {
    from: { type: "string" },
    xml: { type: "string" },
    blog: { type: "string" },
    categories: { type: "string" },
    api: { type: "string" },
    user: { type: "string" },
    password: { type: "string" },
    redirects: { type: "string" },
    "old-domain": { type: "string", multiple: true },
    "dry-run": { type: "boolean", default: false },
    limit: { type: "string" },
    slug: { type: "string" },
    since: { type: "string" },
    exclude: { type: "string" },
    verbose: { type: "boolean", default: false },
    "suggest-categories": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function fail(msg: string): never {
  console.error(`Erro: ${msg}\n\n${HELP}`);
  process.exit(1);
}

if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (!args.from && !args.xml) fail("informe --from (ou --xml).");
if (!args.blog) fail("informe --blog.");

// Modo de sugestão: só lê a origem e as categorias do site.config.ts; não toca no destino
if (args["suggest-categories"]) {
  if (!args.from) fail("--suggest-categories precisa de --from (lê a REST API da origem).");
  if (!existsSync(path.join("sites", args.blog, "site.config.ts"))) fail(`sites/${args.blog}/ não existe.`);
  process.env.SITE = args.blog;
  const { default: blogSite } = await import("../../site.config.ts");
  try {
    await runSuggest({ from: args.from, blog: args.blog, file: args.categories ?? path.join("sites", args.blog, "categorias-wordpress.txt"), targets: blogSite.categories });
  } catch (err) {
    fail(`não deu para ler as categorias de ${args.from}: ${(err as Error).message}`);
  }
  process.exit(0);
}

if (!args.categories) fail("informe --categories.");
// Linha com "?" (vinda do --suggest-categories) ainda não foi decidida: para antes de qualquer coisa
const undecided = parseCategoryMap(await readFile(args.categories, "utf8")).filter((r) => r.to.trim() === "?");
if (undecided.length) fail(`o mapeamento ${args.categories} ainda tem "?" em: ${undecided.map((r) => r.from).join(", ")}. Troque cada "?" por uma categoria do blog ou apague a linha.`);
const limit = args.limit === undefined ? undefined : Number(args.limit);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) fail("--limit precisa ser um número inteiro a partir de 1.");
const dryRun = args["dry-run"];
if (args.since !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(args.since) || Number.isNaN(Date.parse(`${args.since}T00:00:00Z`)))) fail("--since precisa de uma data no formato AAAA-MM-DD.");
/** Slug comparável: decodificado (%C3%A7 ou %CC%A7), acentos na forma composta, minúsculo. */
const slugKey = (slug: string) => {
  let s = slug.trim();
  try {
    s = decodeURIComponent(s);
  } catch {}
  return s.normalize("NFC").toLowerCase();
};
const excluded = new Set<string>();
if (args.exclude) {
  if (!existsSync(args.exclude)) fail(`--exclude: o arquivo ${args.exclude} não existe.`);
  for (const line of (await readFile(args.exclude, "utf8")).split("\n")) {
    const slug = line.replace(/#.*$/, "").trim();
    if (slug) excluded.add(slugKey(slug));
  }
}
const slugs = args.slug ? args.slug.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

// A configuração do blog (url e categorias) vem do site.config.ts com SITE=<blog>
process.env.SITE = args.blog;
const blogFolder = path.join("sites", args.blog, "site.config.ts");
if (!existsSync(blogFolder) && (!args.api || !args.redirects)) fail(`sites/${args.blog}/ não existe; para blog sem pasta, informe --api e --redirects.`);
const site = (await import("../../site.config.ts")).default;
const redirectsFile = path.resolve(args.redirects ?? path.join("sites", args.blog, "redirects.txt"));
const user = args.user ?? process.env.IMPORT_BLOG_USER;
const password = args.password ?? process.env.IMPORT_BLOG_PASSWORD;
const api = new BlogApi(args.api ?? site.url, user, password);
if (!dryRun && !api.hasAuth) fail("informe --user e --password (ou IMPORT_BLOG_USER e IMPORT_BLOG_PASSWORD) do Wordbee no blog.");

const warnings: string[] = [];
const warn = (msg: string) => warnings.push(msg);

console.log(`${dryRun ? "SIMULAÇÃO (--dry-run): nada será gravado\n" : ""}Destino: ${args.blog} (${api.rest})`);

// ---------------------------------------------------------------- origem
let source: SourceSite;
if (args.from) {
  try {
    source = await readRest(args.from, { limit, slugs, onWarn: warn });
    console.log(`Origem: ${source.url} pela REST API: ${source.total} posts publicados${limit || slugs ? `, importando ${source.posts.length}` : ""}`);
  } catch (err) {
    if (!args.xml) fail(`não deu para ler a REST API de ${args.from}: ${(err as Error).message}`);
    console.log(`REST API indisponível (${(err as Error).message}); usando o XML ${args.xml}`);
    source = await readXml(args.xml, { limit, slugs, base: args.from });
  }
} else {
  source = await readXml(args.xml!, { limit, slugs });
  console.log(`Origem: ${args.xml} (${source.url}): ${source.total} posts publicados${limit || slugs ? `, importando ${source.posts.length}` : ""}`);
}

// ---------------------------------------------------------------- destino
let targets: BlogCategory[];
let canQuery = api.hasAuth;
try {
  const engine = await api.checkEngine();
  if (engine.site !== args.blog) warn(`o destino informa SITE=${engine.site}, e não ${args.blog}`);
  targets = await api.categories();
} catch (err) {
  if (!dryRun) fail(`destino inválido: ${(err as Error).message}. Use --api com o endereço do blog novo.`);
  warn(`API do blog indisponível: ${(err as Error).message}. Categorias lidas do site.config.ts; posts existentes não verificados`);
  targets = site.categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug }));
  canQuery = false;
}
if (canQuery) {
  try {
    await api.checkAuth();
  } catch (err) {
    if (!dryRun) fail(`usuário ou senha do blog recusados: ${(err as Error).message}`);
    warn(`login no blog falhou (${(err as Error).message}); posts existentes não verificados`);
    canQuery = false;
  }
}

const mapper = new CategoryMapper(parseCategoryMap(await readFile(args.categories, "utf8")), targets);
if (mapper.problems.length) {
  console.log(`\nProblemas no mapeamento de categorias:\n${mapper.problems.map((p) => `  - ${p}`).join("\n")}`);
  if (!dryRun) process.exit(1);
}

const hostOf = (u: string) => new URL(u).hostname.toLowerCase().replace(/^www\./, "");
const oldHosts = new Set([hostOf(source.url), ...(args["old-domain"] ?? []).map((h) => h.toLowerCase().replace(/^www\./, ""))]);
const catByPath = new Map(source.categories.map((c) => [c.path, c]));
/** Marca de origem gravada em cada post e nas seções do redirects.txt. */
const origin = `wordpress:${hostOf(source.url)}`;
/** Post que esta origem pode atualizar: da mesma origem, ou da importação antiga (sem domínio). */
const ownPost = (src: string | undefined) => src === origin || src === "wordpress";
const describeSource = (src: string | undefined) =>
  src === "wordbee" ? "publicado pelo Wordbee" : src?.startsWith("wordpress:") ? `importado de ${src.slice("wordpress:".length)}` : src ? `fonte "${src}"` : "sem fonte registrada";

/** Caminho antigo → caminho novo, para links internos. */
function resolveLink(p: string): string | null {
  if (p === "/") return "/";
  const slug = source.allLinks.get(p);
  if (slug) return `/${slug}/`;
  const cat = catByPath.get(p);
  const target = cat && mapper.forCategory(cat);
  return target ? `/category/${target.slug}/` : null;
}

// ---------------------------------------------------------------- imagens
const ACCEPTED = new Set(["jpeg", "png", "webp"]);
const MAX_BYTES = 15 * 1024 * 1024;

interface ImageResult {
  ok: boolean;
  /** Caminho novo (/wp-content/uploads/…) ou, na simulação, a URL que seria baixada. */
  target?: string;
  /** URL de onde veio. */
  from?: string;
  /** Id da mídia no blog. */
  id?: number;
  error?: string;
}
const imageCache = new Map<string, Promise<ImageResult>>();

async function download(candidates: string[]): Promise<{ data: Buffer; url: string }> {
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const res = await fetchWithRetry(url, {}, 60_000, 2);
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok) errors.push(`HTTP ${res.status}`);
      else if (!type.startsWith("image/")) errors.push(`não é imagem (${type || "sem tipo"})`);
      else return { data: Buffer.from(await res.arrayBuffer()), url };
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error([...new Set(errors)].join("; "));
}

async function probe(candidates: string[]): Promise<string> {
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      let res = await fetchWithRetry(url, { method: "HEAD" }, 30_000, 2);
      if (res.status === 405 || res.status === 403) res = await fetchWithRetry(url, { headers: { Range: "bytes=0-0" } }, 30_000, 2);
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.startsWith("image/")) return url;
      errors.push(res.ok ? `não é imagem (${type || "sem tipo"})` : `HTTP ${res.status}`);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error([...new Set(errors)].join("; "));
}

/** Formato que a API aceita (JPEG, PNG ou WebP) e tamanho abaixo do limite de upload. */
async function uploadable(data: Buffer): Promise<{ data: Buffer; type: string }> {
  const meta = await sharp(data, { limitInputPixels: 50_000_000 }).metadata();
  if (meta.format === "svg") throw new Error("SVG não é suportado pelo blog");
  if (meta.format && ACCEPTED.has(meta.format) && data.length <= MAX_BYTES) return { data, type: `image/${meta.format}` };
  // GIF, AVIF, TIFF ou arquivo grande demais: PNG/JPEG equivalente, que o blog otimiza
  const img = sharp(data, { limitInputPixels: 50_000_000, animated: false }).rotate().resize({ width: 3000, withoutEnlargement: true });
  return meta.hasAlpha ? { data: await img.png().toBuffer(), type: "image/png" } : { data: await img.jpeg({ quality: 90 }).toBuffer(), type: "image/jpeg" };
}

function handleImage(ref: ImageRef): Promise<ImageResult> {
  const key = imageKey(ref.url);
  let job = imageCache.get(key);
  if (!job) {
    job = (async (): Promise<ImageResult> => {
      try {
        if (dryRun) {
          const url = await probe(ref.candidates);
          return { ok: true, target: url, from: url };
        }
        const { data, url } = await download(ref.candidates);
        const file = await uploadable(data);
        const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "imagem");
        const media: BlogMedia = await api.uploadMedia(file.data, file.type, name, ref.alt);
        return { ok: true, target: new URL(media.source_url).pathname, from: url, id: media.id };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    })();
    imageCache.set(key, job);
  }
  return job;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    })
  );
  return out;
}

// ---------------------------------------------------------------- posts
const report = {
  created: [] as string[],
  updated: [] as string[],
  unchanged: [] as string[],
  unverified: [] as string[],
  failed: [] as { slug: string; error: string }[],
  /** Não importados, de propósito: categoria marcada com "-", data antes do --since ou slug do --exclude. */
  ignored: [] as string[],
  ignoredSince: [] as string[],
  excluded: [] as string[],
  /** Slug já usado no blog por post de outra fonte: não foi atualizado. */
  conflicts: [] as { slug: string; existing: string; link: string }[],
  images: [] as { post: string; url: string; error: string }[],
  imagesOk: 0,
  altGenerated: 0,
};
const redirects = new Map<string, string>();
const addRedirect = (from: string, to: string) => {
  if (from !== to && from !== "/") redirects.set(from, to);
};

async function importPost(post: SourcePost, n: number): Promise<void> {
  const label = `[${n}/${source.posts.length}] ${post.slug}`;
  // Antes de qualquer imagem ou chamada ao blog: estes posts ficam de fora, sem falha e sem redirect
  if (excluded.has(slugKey(post.slug))) {
    report.excluded.push(post.slug);
    console.log(`${dryRun ? "\n" : ""}${label}: ignorado (excluído pelo ${path.basename(args.exclude!)})`);
    return;
  }
  if (mapper.skips(post.categories)) {
    report.ignored.push(post.slug);
    console.log(`${dryRun ? "\n" : ""}${label}: ignorado (categoria ${post.categories.map((c) => c.slug).join(", ")} marcada com "-" no mapeamento)`);
    return;
  }
  if (args.since && post.dateGmt.slice(0, 10) < args.since) {
    report.ignoredSince.push(post.slug);
    console.log(`${dryRun ? "\n" : ""}${label}: ignorado (antes de ${args.since}: publicado em ${post.dateGmt.slice(0, 10)})`);
    return;
  }
  const category = mapper.forPost(post.categories);
  if (!category) throw new Error(`nenhuma regra de categoria para ${post.categories.map((c) => c.slug).join(", ") || "(sem categoria)"}`);

  // Antes de baixar imagens: slug ocupado por post de outra fonte não é tocado
  const existing = canQuery ? await api.findPost(post.slug) : null;
  if (existing && existing.meta === undefined) fail("o blog de destino não informa a origem dos posts: faça o deploy da versão nova do servidor antes de importar.");
  if (existing && !ownPost(existing.meta?.source)) {
    report.conflicts.push({ slug: post.slug, existing: describeSource(existing.meta?.source), link: existing.link });
    console.log(`${dryRun ? "\n" : ""}${label}: conflito: o slug já é de um post ${describeSource(existing.meta?.source)} (${existing.link}); nada foi alterado`);
    return;
  }

  const prep = prepareHtml(post.html, { base: source.url, oldHosts, postTitle: post.title, resolveLink });
  const featuredRef: ImageRef | undefined = post.featured && {
    url: post.featured.url,
    candidates: originalCandidates(post.featured.url),
    alt: post.featured.alt || post.title,
    altGenerated: !post.featured.alt,
  };
  const refs = featuredRef ? [featuredRef, ...prep.images] : prep.images;
  const results = await pool(refs, 4, handleImage);
  const byKey = new Map<string, ImageResult>();
  refs.forEach((ref, i) => {
    const r = results[i]!;
    byKey.set(imageKey(ref.url), r);
    if (!r.ok) report.images.push({ post: post.slug, url: ref.url, error: r.error ?? "" });
    else {
      report.imagesOk++;
      if (ref.altGenerated) report.altGenerated++;
    }
  });
  const html = finishHtml(prep, (url) => {
    const r = byKey.get(imageKey(url));
    return r?.ok ? (dryRun ? url : r.target!) : null;
  });
  const featured = featuredRef ? byKey.get(imageKey(featuredRef.url)) : undefined;

  const featuredId = featured?.ok ? featured.id : undefined;

  const body: Record<string, unknown> = {
    title: post.title,
    content: html,
    status: "publish",
    excerpt: post.excerpt,
    slug: post.slug,
    categories: [category.id],
    date_gmt: post.dateGmt,
    ...(post.modifiedGmt ? { modified_gmt: post.modifiedGmt } : {}),
    meta: { seo_title: post.seoTitle ?? "", seo_description: post.seoDescription ?? "", source: origin },
  };
  const status = !canQuery ? "a verificar" : existing ? "atualizaria" : "criaria";
  const oldPath = pathOf(post.link);

  if (dryRun) {
    const newPath = existing ? pathOf(existing.link) : `/${post.slug}/`;
    addRedirect(oldPath, newPath);
    (status === "atualizaria" ? report.updated : status === "criaria" ? report.created : report.unverified).push(post.slug);
    const s = prep.stats;
    console.log(`\n${label}: ${status}`);
    console.log(`  título:      ${post.title}`);
    console.log(`  data:        ${post.dateGmt}Z   categoria: ${post.categories.map((c) => c.slug).join(", ")} → ${category.slug}`);
    console.log(`  URL:         ${oldPath} → ${newPath}${oldPath === newPath ? " (igual, sem redirect)" : ""}`);
    console.log(`  meta title:  ${!post.seoTitle ? "(nenhum; usa o título)" : post.seoTitle === post.title ? "(igual ao título)" : post.seoTitle}`);
    console.log(`  meta desc.:  ${post.seoDescription ?? "(nenhuma; usa o resumo)"}`);
    console.log(`  destacada:   ${featuredRef ? `${featured?.ok ? "ok" : "FALHA"} ${featured?.from ?? featuredRef.url} (alt ${featuredRef.altGenerated ? "gerado" : "original"}: "${featuredRef.alt}")` : "(nenhuma)"}`);
    console.log(`  no corpo:    ${prep.images.length} imagens (${prep.images.filter((i) => i.altGenerated).length} com alt gerado), ${s.linksRewritten} links internos reescritos${s.linksUnresolved.length ? `, ${s.linksUnresolved.length} sem destino conhecido (${s.linksUnresolved.join(", ")})` : ""}`);
    if (s.videosLinked || s.embedsRemoved || s.shortcodes.length) {
      console.log(`  limpeza:     ${s.videosLinked} vídeo(s) do YouTube viraram link, ${s.embedsRemoved} incorporação(ões) removida(s), shortcodes: ${s.shortcodes.join(", ") || "nenhum"}`);
    }
    console.log(`  HTML:        ${post.html.length} → ${html.length} caracteres`);
    if (args.verbose) console.log(`  ---\n${html.slice(0, 1200).replace(/^/gm, "  | ")}\n  ---`);
    return;
  }

  let link: string;
  if (existing) {
    const { changed, post: saved } = await api.updatePost(existing.id, { ...body, featured_media: featuredId ?? 0 });
    (changed ? report.updated : report.unchanged).push(post.slug);
    link = saved.link;
    console.log(`${label}: ${changed ? "atualizado" : "sem mudanças"} → ${link}`);
  } else {
    const { created, post: saved } = await api.createPost({ ...body, ...(featuredId ? { featured_media: featuredId } : {}) });
    (created ? report.created : report.unchanged).push(post.slug);
    link = saved.link;
    console.log(`${label}: ${created ? "importado" : "já existia igual"} → ${link}`);
    if (saved.slug !== post.slug) warn(`${post.slug}: o slug estava ocupado (página fixa ou reservado) e virou ${saved.slug}`);
  }
  addRedirect(oldPath, pathOf(link));
  refs.forEach((ref, i) => {
    const r = results[i]!;
    if (r.ok && r.target) {
      addRedirectForImage(ref.url, r.target);
      if (r.from && r.from !== ref.url) addRedirectForImage(r.from, r.target);
    }
  });
  const s = prep.stats;
  if (s.linksUnresolved.length) warn(`${post.slug}: links internos sem destino conhecido (mantidos com o mesmo caminho): ${s.linksUnresolved.join(", ")}`);
  if (s.embedsRemoved) warn(`${post.slug}: ${s.embedsRemoved} incorporação(ões) que não são do YouTube foram removidas`);
}

/** Endereço antigo de imagem do próprio site → endereço novo (Google Imagens e links de fora). */
function addRedirectForImage(oldUrl: string, newPath: string) {
  try {
    const u = new URL(oldUrl);
    if (!oldHosts.has(u.hostname.toLowerCase().replace(/^www\./, "")) || !newPath.startsWith("/")) return;
    addRedirect(decodeURI(u.pathname), newPath);
  } catch {}
}

// Slug do --exclude que não está na origem: provável erro de digitação
if (excluded.size) {
  const known = new Set([...source.allLinks.values(), ...source.posts.map((p) => p.slug)].map(slugKey));
  for (const slug of excluded) if (!known.has(slug)) warn(`--exclude: o slug "${slug}" não existe na origem`);
}

let n = 0;
for (const post of source.posts) {
  n++;
  try {
    await importPost(post, n);
  } catch (err) {
    report.failed.push({ slug: post.slug, error: (err as Error).message });
    console.log(`[${n}/${source.posts.length}] ${post.slug}: FALHA: ${(err as Error).message}`);
  }
}

// Categorias antigas → novas (vale para todas as mapeadas, não só as dos posts importados)
for (const c of source.categories) {
  const target = mapper.forCategory(c);
  if (target) addRedirect(c.path, `/category/${target.slug}/`);
}

const red = await writeRedirects(redirectsFile, redirects, dryRun, origin);

// ---------------------------------------------------------------- relatório
const line = "-".repeat(60);
console.log(`\n${line}\nRELATÓRIO${dryRun ? " (simulação: nada foi gravado)" : ""}\n${line}`);
if (dryRun) {
  console.log(`Seriam importados (novos): ${report.created.length}${report.created.length ? `  ${report.created.join(", ")}` : ""}`);
  console.log(`Seriam atualizados:        ${report.updated.length}${report.updated.length ? `  ${report.updated.join(", ")}` : ""}`);
  if (report.unverified.length) console.log(`Novos ou atualizados (sem acesso à API para conferir): ${report.unverified.length}`);
} else {
  console.log(`Importados:   ${report.created.length}`);
  console.log(`Atualizados:  ${report.updated.length}`);
  console.log(`Sem mudanças: ${report.unchanged.length}`);
}
const ignoredTotal = report.ignored.length + report.ignoredSince.length + report.excluded.length;
const reasons = [
  report.ignored.length ? `categoria com "-": ${report.ignored.length}` : "",
  report.ignoredSince.length ? `antes de ${args.since}: ${report.ignoredSince.length}` : "",
  report.excluded.length ? `excluídos: ${report.excluded.length}` : "",
].filter(Boolean);
console.log(`Ignorados:    ${ignoredTotal}${ignoredTotal ? ` (${reasons.join("; ")}; não são falha)` : ""}`);
for (const slug of report.excluded) console.log(`  - excluído: ${slug}`);
console.log(`Falhas:       ${report.failed.length}`);
for (const f of report.failed) console.log(`  - ${f.slug}: ${f.error}`);
console.log(`Conflitos:    ${report.conflicts.length}${report.conflicts.length ? " (slug já usado no blog por post de outra fonte; não foram alterados)" : ""}`);
for (const c of report.conflicts) console.log(`  - ${c.slug}: post ${c.existing} (${c.link})`);
console.log(`Imagens:      ${report.imagesOk} ${dryRun ? "disponíveis para baixar" : "enviadas"} (${report.altGenerated} com alt gerado), ${report.images.length} ${dryRun ? "que não baixariam" : "que não baixaram"}`);
for (const i of report.images) console.log(`  - ${i.post}: ${i.url} (${i.error})`);
console.log(`Redirects:    ${red.added} nov${red.added === 1 ? "o" : "os"}, ${red.total} no bloco gerado de ${path.relative(process.cwd(), redirectsFile)}${dryRun ? " (não gravado)" : ""}`);
if (dryRun) for (const [from, to] of redirects) console.log(`  ${from} → ${to}`);
for (const s of red.skipped) console.log(`  ignorado: ${s}`);
if (red.adopted) console.log(`  ${red.adopted} regra(s) antiga(s) sem origem passaram para a seção "${origin}"`);
if (red.conflicts.length) {
  console.log(`  conflitos de redirect: ${red.conflicts.length} (o caminho já é de outra origem; ficou como estava)`);
  for (const c of red.conflicts) console.log(`    ${c.from}: queria → ${c.to}, continua → ${c.kept} (${c.owner})`);
}
if (warnings.length) {
  console.log(`Avisos:`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (!dryRun && red.added) console.log(`\nO redirects.txt é lido quando o servidor inicia: publique-o (commit e deploy) para os 301 valerem.`);
process.exit(report.failed.length || report.conflicts.length || red.conflicts.length ? 2 : 0);
