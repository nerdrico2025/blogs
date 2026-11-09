/**
 * Serve o site e as imagens no mesmo processo da API (substitui o Nginx dentro do container):
 *   /                      → CURRENT_LINK (symlink do release no ar), com .br/.gz pré-comprimidos
 *   /wp-content/uploads/   → UPLOADS_DIR, direto do disco (abre antes de qualquer build)
 * Política de cache e redirecionamentos equivalentes ao antigo deploy/nginx-blog.conf.
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";
import site from "../site.config.ts";
import type { ApiEnv } from "./env.ts";
import { ORIGINALS_DIR } from "./brand-images.ts";
import { APPLE_TOUCH_ICON, FAVICON_ICO, FAVICON_SVG } from "./favicon.ts";

const YEAR = "public, max-age=31536000, immutable";

/** Cache por caminho/tipo. HTML sempre revalida, para posts novos aparecerem na hora. */
export function cacheControl(urlPath: string): string {
  if (urlPath.startsWith("/_astro/")) return YEAR;
  if (urlPath.startsWith("/pagefind/")) return "public, max-age=600";
  if (urlPath.startsWith("/brand/")) return "public, max-age=86400";
  if (/\.(xml|txt)$/.test(urlPath)) return "public, max-age=600";
  if (urlPath.endsWith("/") || urlPath.endsWith(".html")) return "public, max-age=0, must-revalidate";
  return "public, max-age=3600";
}

const BLOCKED = /^\/(wp-admin|wp-includes|wp-login\.php|xmlrpc\.php)(\/|$)|\/\./;
/** Links antigos do WordPress com data: /2024/05/slug/ ou /2024/05/31/slug/ */
const DATED = /^\/\d{4}\/\d{2}\/(?:\d{2}\/)?([a-z0-9-]+)\/?$/;

/**
 * Redirecionamentos 301 de um blog migrado: sites/<SITE>/redirects.txt, uma regra por linha,
 * "/caminho-antigo/ /caminho-novo/" (linhas vazias e com # são ignoradas).
 */
/**
 * Regra do redirects.txt para um caminho já decodificado, com ou sem a barra no fim. Acentos são comparados
 * na forma composta (NFC): o WordPress pode ter gravado "ç" como "c" + cedilha e o navegador mandar "%C3%A7".
 */
export function findRedirect(redirects: Map<string, string>, p: string): string | undefined {
  const n = p.normalize("NFC");
  return redirects.get(n) ?? redirects.get(n.endsWith("/") ? n.slice(0, -1) : `${n}/`);
}

/** Tipos aceitos na 3ª coluna do redirects.txt. Sem ela, 301 (permanente). */
export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];

/**
 * Regras do redirects.txt com o tipo: "/antigo /novo" (301) ou "/antigo /novo 307". Um temporário
 * (302 ou 307) serve para link curto de afiliado: o navegador não guarda o destino.
 */
export function loadRedirectRules(file: string): Map<string, { to: string; status: RedirectStatus }> {
  const map = new Map<string, { to: string; status: RedirectStatus }>();
  if (!existsSync(file)) return map;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [from, to, code, ...rest] = line.split(/\s+/);
    const status = code === undefined ? 301 : (Number(code) as RedirectStatus);
    if (!from?.startsWith("/") || !to || !(to.startsWith("/") || /^https?:\/\//.test(to)) || rest.length || !REDIRECT_STATUSES.includes(status)) {
      throw new Error(`redirects.txt: linha inválida: "${line}" (use "/antigo /novo" ou "/antigo /novo 307")`);
    }
    map.set(from.normalize("NFC"), { to, status });
  }
  return map;
}

export function loadRedirects(file: string): Map<string, string> {
  return new Map([...loadRedirectRules(file)].map(([from, r]) => [from, r.to]));
}

/** Tipo da regra (301 quando não há regra ou ela não diz o tipo). */
export function redirectStatus(rules: Map<string, { status: RedirectStatus }>, p: string): RedirectStatus {
  const n = p.normalize("NFC");
  return (rules.get(n) ?? rules.get(n.endsWith("/") ? n.slice(0, -1) : `${n}/`))?.status ?? 301;
}

const SETUP_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Em configuração</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f0f5fa;color:#334155;text-align:center;padding:24px}h1{color:#1e293b;margin:0 0 8px}</style></head><body><main><h1>Em configuração</h1><p>Este blog estará no ar em breve.</p></main></body></html>`;

export async function registerStatic(app: FastifyInstance, env: ApiEnv, isConfigured: () => boolean = () => true): Promise<void> {
  await mkdir(env.uploadsDir, { recursive: true });
  const redirectRules = loadRedirectRules(env.redirectsFile);
  const redirects = new Map([...redirectRules].map(([from, r]) => [from, r.to]));

  const notFoundPage = (reply: FastifyReply) => {
    const page = path.join(env.currentLink, "404.html");
    if (!existsSync(page)) {
      return reply.code(503).type("text/plain; charset=utf-8").header("Retry-After", "30").send("O site está sendo publicado. Tente de novo em instantes.");
    }
    return reply.code(404).type("text/html; charset=utf-8").header("Cache-Control", "public, max-age=0, must-revalidate").send(createReadStream(page));
  };
  app.decorate("blogNotFound", notFoundPage);

  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD") return;
    const p = decodeURIComponent(req.url.split("?")[0]!);
    if (!isConfigured() && !/^\/(admin|health|wp-json)(\/|$)/.test(p)) {
      return reply.code(503).type("text/html; charset=utf-8").header("Retry-After", "3600").header("X-Robots-Tag", "noindex, nofollow").send(SETUP_PAGE);
    }
    // Slug de categoria renomeado no /admin
    const renamed = p.match(/^\/category\/([^/]+)(\/.*)?$/);
    if (renamed) {
      const cat = site.categories.find((c) => c.aliases?.includes(renamed[1]!));
      if (cat) return reply.redirect(`/category/${cat.slug}${renamed[2] ?? "/"}`, 301);
    }
    // Nome do autor trocado no /admin
    const author = p.match(/^\/autor\/([^/]+)\/?$/);
    if (author && site.authorProfile?.aliases?.includes(author[1]!)) return reply.redirect(`/autor/${site.authorProfile.slug}/`, 301);
    // Caminhos do WordPress que não existem aqui e arquivos ocultos
    if (BLOCKED.test(p) && !p.startsWith("/.well-known/")) return notFoundPage(reply);
    // Migração: lista do blog, com ou sem barra no fim
    const target = findRedirect(redirects, p);
    if (target) {
      const status = redirectStatus(redirectRules, p);
      // Link curto (temporário): o navegador e o Cloudflare não guardam o destino
      if (status !== 301 && status !== 308) reply.header("Cache-Control", "no-store");
      return reply.redirect(target, status);
    }
    // Link antigo com data, quando o post existe aqui
    const dated = p.match(DATED);
    if (dated && existsSync(path.join(env.currentLink, dated[1]!, "index.html"))) return reply.redirect(`/${dated[1]}/`, 301);
  });

  app.get("/feed/", (_req, reply) => reply.redirect("/feed.xml", 301));
  app.get("/feed", (_req, reply) => reply.redirect("/feed.xml", 301));

  await app.register(fastifyStatic, {
    root: env.uploadsDir,
    prefix: "/wp-content/uploads/",
    decorateReply: false,
    index: false,
    redirect: false,
    allowedPath: (p) => !p.endsWith(".json"),
    setHeaders: (reply) => void reply.header("Cache-Control", YEAR),
  });

  await mkdir(env.assetsDir, { recursive: true });
  // Endereços fixos que navegadores e buscadores pedem sozinhos; a troca do ícone vale em até 1 dia mesmo sem o ?v=
  for (const [url, file, type] of [["/favicon.ico", FAVICON_ICO, "image/x-icon"], ["/apple-touch-icon.png", APPLE_TOUCH_ICON, "image/png"]] as const) {
    app.get(url, (_req, reply) => {
      const full = path.join(env.assetsDir, file);
      if (!existsSync(full)) return notFoundPage(reply);
      return reply.type(type).header("Cache-Control", "public, max-age=86400").send(createReadStream(full));
    });
  }
  await app.register(fastifyStatic, {
    root: env.assetsDir,
    prefix: "/assets/",
    decorateReply: false,
    index: false,
    redirect: false,
    // Os originais nunca são públicos. Minúsculas: em disco sem diferença de caixa, ORIGINAIS abriria a mesma pasta
    allowedPath: (p) => !path.posix.normalize(`/${p}`).toLowerCase().startsWith(`/${ORIGINALS_DIR}/`),
    setHeaders: (reply, filePath) => {
      reply.header("Cache-Control", "public, max-age=86400");
      // SVG enviado no painel: abrir o endereço direto não pode executar script nesta origem
      if (path.basename(filePath) === FAVICON_SVG) reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    },
  });

  await app.register(fastifyStatic, {
    root: env.currentLink,
    prefix: "/",
    decorateReply: false,
    index: ["index.html"],
    redirect: true,
    preCompressed: true,
    setHeaders: (reply, filePath) => {
      const rel = "/" + path.relative(env.currentLink, filePath).split(path.sep).join("/").replace(/\.(br|gz)$/, "");
      const urlPath = rel.endsWith("/index.html") ? rel.slice(0, -"index.html".length) : rel;
      reply.header("Cache-Control", cacheControl(urlPath));
    },
  });
}

declare module "fastify" {
  interface FastifyInstance {
    blogNotFound?: (reply: FastifyReply) => FastifyReply;
  }
}
