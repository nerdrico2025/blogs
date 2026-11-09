/**
 * /admin: configurações do blog, com login próprio, e /admin/setup: assistente de primeiro acesso.
 * Plugin isolado: os parsers de corpo daqui não valem para os 4 endpoints do Wordbee.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import YAML from "yaml";
import site from "../site.config.ts";
import { generateBrand } from "../scripts/lib/brand.ts";
import { AD_POSITIONS, DEFAULT_HEADER_COLOR, contrastWarnings, type Settings } from "../shared/settings.ts";
import { hasSiteFolder, siteDir } from "../src/lib/site-id.ts";
import { runBackup } from "./backup.ts";
import { IMAGE_GENERATOR_VERSION, missingOriginals, removeAuthorPhoto, storeAuthorPhoto, storeBrandImage } from "./brand-images.ts";
import { Attempts, Authenticator, generateAppPassword, hashPassword, isValidHash } from "./auth.ts";
import type { BuildQueue } from "./build-queue.ts";
import { clientIp } from "./client-ip.ts";
import type { ApiEnv } from "./env.ts";
import { WpError } from "./errors.ts";
import type { SecretStore } from "./secrets.ts";
import { brokenCategoryLinks, generateProposal, validateProposal, type SetupProposal } from "./setup-ai.ts";
import { mergeCategories, parseAds, parseAdsenseClient, parseAuthor, parseColors, parseGaId, parseHome, parseSiteUrl, parseTexts, parseTracking, type SettingsStore } from "./settings-store.ts";
import type { Store } from "./store.ts";

const COOKIE = "blog_admin";
const SESSION_MS = 12 * 3600 * 1000;
const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "admin-ui");
const UI_FILES: Record<string, string> = { "admin.css": "text/css", "admin.js": "text/javascript", "color.js": "text/javascript", "modal.js": "text/javascript", "setup.js": "text/javascript" };
const digest = (s: string) => createHash("sha256").update(s).digest();
const WORDBEE_USER = "wordbee";
/** Marcadores aceitos nas páginas fixas (src/lib/placeholders.ts). Outro marcador faria a publicação falhar. */
const PAGE_PLACEHOLDERS = new Set(["site.name", "site.url", "site.domain", "contact.email", "legal.owner", "legal.city"]);
const PAGE_LIMITS = { title: 120, description: 300, body: 60_000 };
const SHARE_IMAGE = { width: 1200, height: 630 };

/** Arquivos (não pastas) dentro de uma pasta, contando as subpastas. */
async function countFiles(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) n++;
  return n;
}

const cleanUrl = (v: string | undefined) => (v ?? "").trim().replace(/\/+$/, "");
const hostOf = (url: string) => new URL(url).host.toLowerCase();
/** O que a pessoa digitou para confirmar: aceita com ou sem https:// e barra no fim. */
const typedHost = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");

export interface AdminDeps {
  env: ApiEnv;
  store: Store;
  builds: BuildQueue;
  settings: SettingsStore;
  secrets: SecretStore;
}

export const adminCredentials = (env: ApiEnv, secrets: SecretStore) =>
  env.adminUser && env.adminPasswordHash
    ? { user: env.adminUser, passwordHash: env.adminPasswordHash }
    : { user: secrets.data.adminUser ?? "", passwordHash: secrets.data.adminPasswordHash ?? "" };

export async function registerAdmin(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { env, store, builds, settings, secrets } = deps;
  const sessions = new Map<string, number>();
  // Usuário sem diferença de maiúsculas e sem espaços nas pontas: o teclado do celular muda os dois
  const adminUserKey = (user: string) => user.trim().toLowerCase();
  const login = new Authenticator(
    () => {
      const c = adminCredentials(env, secrets);
      return { ...c, user: adminUserKey(c.user) };
    },
    5,
    15 * 60_000,
    (reason, ip) => app.log.warn({ ip, reason, source: env.adminUser && env.adminPasswordHash ? "variáveis ADMIN_*" : "secrets.json" }, `login do /admin recusado: ${reason}`)
  );
  if (Boolean(env.adminUser) !== Boolean(env.adminPasswordHash)) {
    app.log.warn("ADMIN_USER e ADMIN_PASSWORD_HASH precisam estar juntas; com só uma delas, as variáveis são ignoradas");
  }
  if (env.adminPasswordHash && !isValidHash(env.adminPasswordHash)) {
    app.log.warn("ADMIN_PASSWORD_HASH está em formato inválido; gere de novo com npm run admin:password");
  }
  const setupAttempts = new Attempts(5);

  const authEnabled = () => Boolean(adminCredentials(env, secrets).passwordHash);
  const token = (req: FastifyRequest) => req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
  const hasSession = (req: FastifyRequest) => {
    const t = token(req);
    if (!t) return false;
    const key = digest(t).toString("hex");
    const until = sessions.get(key);
    if (!until || until < Date.now()) {
      sessions.delete(key);
      return false;
    }
    return true;
  };
  const requireSession = async (req: FastifyRequest) => {
    if (!hasSession(req)) throw new WpError(401, "admin_login_required", "Entre de novo para continuar.");
  };
  const setCookie = (req: FastifyRequest, reply: FastifyReply, value: string, maxAge: number) => {
    const secure = req.protocol === "https" ? "; Secure" : "";
    reply.header("Set-Cookie", `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
  };

  const page = async (reply: FastifyReply, file: string) =>
    reply.type("text/html; charset=utf-8").send(await readFile(path.join(UI, file)));

  await app.register(async (scope) => {
    // jpeg, png e webp já têm parser no app
    scope.addContentTypeParser(["image/svg+xml"], { parseAs: "buffer", bodyLimit: env.maxUploadBytes }, (_req, body, done) => done(null, body));

    scope.addHook("onRequest", async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("X-Robots-Tag", "noindex, nofollow");
      // Reforço contra CSRF, além do SameSite=Strict
      const origin = req.headers.origin;
      if (req.method === "POST" && origin && new URL(origin).host !== req.host) throw new WpError(403, "bad_origin", "Origem não permitida.");
    });

    scope.get("/admin/ui/:file", async (req, reply) => {
      const file = (req.params as { file: string }).file;
      const type = UI_FILES[file];
      if (!type) throw new WpError(404, "rest_no_route", "Arquivo não encontrado.");
      return reply.type(`${type}; charset=utf-8`).send(await readFile(path.join(UI, file)));
    });

    // --- Login e painel ---
    scope.get("/admin", (_req, reply) => reply.redirect("/admin/", 302));
    scope.get("/admin/", async (_req, reply) => {
      if (!settings.isConfigured()) return reply.redirect("/admin/setup", 302);
      return page(reply, "admin.html");
    });

    // Um endereço para cada tela do painel; quem escolhe o que mostrar é o admin.js
    for (const screen of ["artigos", "categorias", "paginas", "autor", "marca", "home", "textos", "anuncios", "rastreamento", "dominio", "wordbee"]) {
      for (const url of [`/admin/${screen}`, `/admin/${screen}/`]) {
        scope.get(url, async (_req, reply) => {
          if (!settings.isConfigured()) return reply.redirect("/admin/setup", 302);
          return page(reply, "admin.html");
        });
      }
    }

    scope.post("/admin/api/login", async (req, reply) => {
      if (!authEnabled()) throw new WpError(403, "admin_disabled", "O painel está desligado: defina ADMIN_USER e ADMIN_PASSWORD_HASH.");
      const b = (req.body ?? {}) as { user?: unknown; password?: unknown };
      login.checkPassword(adminUserKey(String(b.user ?? "")), String(b.password ?? ""), clientIp(req));
      const t = randomBytes(32).toString("base64url");
      sessions.set(digest(t).toString("hex"), Date.now() + SESSION_MS);
      setCookie(req, reply, t, SESSION_MS / 1000);
      return { ok: true };
    });

    scope.post("/admin/api/logout", async (req, reply) => {
      const t = token(req);
      if (t) sessions.delete(digest(t).toString("hex"));
      setCookie(req, reply, "", 0);
      return { ok: true };
    });

    const stateJson = () => {
      const s = settings.current;
      const c = site.theme.colors;
      return {
        name: site.name,
        tagline: site.tagline,
        description: site.description,
        url: site.url,
        domain: { saved: s.siteUrl ?? "", env: cleanUrl(process.env.SITE_URL), effective: site.url },
        shareImage: site.seo.defaultImage.src,
        texts: {
          contactEmail: site.contact.email,
          legalOwner: site.legal.owner,
          legalCity: site.legal.city,
          cookies: site.cookies.text,
          affiliateNotice: site.article.affiliateNotice.enabled ? site.article.affiliateNotice.text : "",
          authorBoxKicker: site.article.authorBox.kicker,
        },
        analytics: { gaId: site.analytics.gaId, adsenseClient: site.analytics.adsenseClient },
        checklist: s.resetAt ? checklist(s) : null,
        logo: site.logo.src,
        logoDark: site.logoDark?.src ?? "",
        missingOriginals: missingOriginals(env.assetsDir, s.brand),
        favicon: site.favicon,
        colors: { primary: c.accent, highlight: site.theme.highlight ?? c.accent, callout: c.calloutFrom, header: site.theme.header ?? DEFAULT_HEADER_COLOR },
        // Fonte do site, usada também nos modais do painel
        fontFamily: site.theme.fontFamily,
        warnings: contrastWarnings({ primary: c.accent, highlight: site.theme.highlight, callout: c.calloutFrom }),
        tracking: { gtmId: s.tracking?.gtmId ?? "", headCode: s.tracking?.headCode ?? "", bodyCode: s.tracking?.bodyCode ?? "" },
        ads: { headScript: s.ads?.headScript ?? "", adsTxt: s.ads?.adsTxt ?? site.adsTxt.join("\n"), slots: s.ads?.slots ?? {} },
        positions: AD_POSITIONS,
        author: s.authorProfile ?? null,
        // Assinatura usada enquanto não houver nome
        authorFallback: site.authors[site.defaultAuthor]!.name,
        // A lista salva vale mesmo com os relógios desmarcados, para ninguém perder as cidades
        home: {
          tools: site.sidebar.tools,
          callout: site.sidebar.callout,
          ticker: {
            enabled: site.ticker.enabled,
            showRates: s.home?.ticker?.showRates ?? site.ticker.rates.length > 0,
            showClocks: s.home?.ticker?.showClocks ?? site.ticker.clocks.length > 0,
            clocks: s.home?.ticker?.clocks ?? site.ticker.clocks,
          },
          footerText: site.footer.text,
          searchPlaceholder: site.sidebar.search.placeholder,
        },
        categories: site.categories,
        wordbee: { managedByEnv: Boolean(env.passwordHash), user: env.passwordHash ? env.user : secrets.data.wordbeeUser ?? WORDBEE_USER, hasPassword: Boolean(env.passwordHash || secrets.data.wordbeePasswordHash) },
        build: builds.getStatus(),
        maxUploadBytes: env.maxUploadBytes,
      };
    };

    /** Depois de "Reiniciar para novo domínio": o que falta preencher, com a tela onde se faz. */
    function checklist(s: Settings) {
      return [
        { screen: "marca", label: "Marca: nome, logotipo e favicon", done: Boolean(s.brand?.name && s.brand?.logo && s.brand?.favicon) },
        { screen: "marca", label: "Nicho: frase e descrição do blog", done: Boolean(s.tagline && s.description) },
        { screen: "dominio", label: "Domínio novo", done: Boolean(s.siteUrl) },
        { screen: "categorias", label: "Categorias do novo nicho", done: Boolean(s.categories?.length) },
        { screen: "paginas", label: "Páginas fixas (Sobre, Contato e textos legais)", done: env.pagesDir === env.volumePagesDir },
        { screen: "autor", label: "Autor e e-mail de contato", done: Boolean(s.authorProfile?.name && s.contact?.email) },
        { screen: "anuncios", label: "AdSense e ads.txt", done: Boolean(s.analytics?.adsenseClient || s.ads?.adsTxt?.trim()) },
        { screen: "rastreamento", label: "Google Tag Manager", done: Boolean(s.tracking?.gtmId) },
      ];
    }

    /** Valida, grava de forma atômica e pede o rebuild (a fila respeita a trava global). */
    const save = async (reason: string, fn: (s: Settings) => Settings) => {
      await settings.update(fn);
      builds.request(`configurações: ${reason}`);
      return stateJson();
    };

    const session = { preHandler: requireSession };
    scope.get("/admin/api/state", session, async () => stateJson());
    scope.get("/admin/api/build", session, async () => ({ build: builds.getStatus() }));

    scope.post("/admin/api/brand", session, async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const colors = parseColors((b.colors ?? {}) as Record<string, unknown>);
      // Cor que veio igual à atual e nunca foi definida aqui continua vindo do site.config.ts
      const effective = { primary: site.theme.colors.accent, highlight: site.theme.highlight ?? site.theme.colors.accent, callout: site.theme.colors.calloutFrom };
      for (const key of ["primary", "highlight", "callout"] as const) {
        if (colors[key] === effective[key] && !settings.current.brand?.colors?.[key]) delete colors[key];
      }
      // O cabeçalho tem padrão fixo: voltar a ele apaga o valor, em vez de guardar o branco
      if (colors.header) colors.header = colors.header.toLowerCase();
      if (colors.header === DEFAULT_HEADER_COLOR) delete colors.header;
      const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
      const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : undefined);
      const tagline = text(b.tagline, 120);
      const description = text(b.description, 300);
      return save("marca", (s) => ({ ...s, brand: { ...s.brand, name, colors }, ...(tagline === undefined ? {} : { tagline }), ...(description === undefined ? {} : { description }) }));
    });

    const imageUpload = (kind: "logo" | "logoDark" | "favicon") => async (req: FastifyRequest) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new WpError(415, "invalid_image", "Envie uma imagem PNG, JPG, WebP ou SVG.");
      try {
        const patch = await storeBrandImage(env.assetsDir, kind, req.body);
        const reason = kind === "favicon" ? "favicon" : kind === "logo" ? "logotipo" : "logotipo para fundo escuro";
        // Sem versão gravada, não há nada pendente: o que acabou de ser gerado já é da versão atual
        return await save(reason, (s) => ({ ...s, imageGenerator: s.imageGenerator ?? IMAGE_GENERATOR_VERSION, brand: { ...s.brand, ...patch } }));
      } catch (err) {
        if (err instanceof WpError) throw err;
        throw new WpError(415, "invalid_image", "Não foi possível ler a imagem. Envie um PNG, JPG, WebP ou SVG válido.");
      }
    };
    scope.post("/admin/api/logo", session, imageUpload("logo"));
    scope.post("/admin/api/logo-dark", session, imageUpload("logoDark"));
    scope.post("/admin/api/favicon", session, imageUpload("favicon"));

    scope.post("/admin/api/share-image", session, async (req) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new WpError(415, "invalid_image", "Envie uma imagem PNG, JPG ou WebP.");
      let data: Buffer;
      try {
        // 1200 × 630, recortada no ponto de interesse, sem metadados (EXIF e GPS)
        data = await sharp(req.body, { failOn: "error", limitInputPixels: 50_000_000 }).rotate().resize({ ...SHARE_IMAGE, fit: "cover", position: "attention" }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      } catch {
        throw new WpError(415, "invalid_image", "Não foi possível ler a imagem. Envie um PNG, JPG ou WebP válido.");
      }
      const name = `og-${createHash("sha256").update(data).digest("hex").slice(0, 10)}.jpg`;
      await mkdir(env.assetsDir, { recursive: true });
      const tmp = path.join(env.assetsDir, `${name}.${process.pid}.tmp`);
      await writeFile(tmp, data);
      await rename(tmp, path.join(env.assetsDir, name));
      return save("imagem de compartilhamento", (s) => ({ ...s, brand: { ...s.brand, defaultImage: `/assets/${name}` } }));
    });

    scope.post("/admin/api/domain", session, async (req) => {
      const siteUrl = parseSiteUrl(((req.body ?? {}) as Record<string, unknown>).siteUrl);
      return save("domínio", (s) => {
        const next = { ...s };
        if (siteUrl) next.siteUrl = siteUrl;
        else delete next.siteUrl;
        return next;
      });
    });

    scope.post("/admin/api/texts", session, async (req) => {
      const texts = parseTexts((req.body ?? {}) as Record<string, unknown>);
      return save("textos", (s) => ({ ...s, ...texts }));
    });

    scope.post("/admin/api/tracking", session, async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const tracking = parseTracking(b);
      const gaId = b.gaId === undefined ? undefined : parseGaId(b.gaId);
      return save("rastreamento", (s) => ({ ...s, tracking, ...(gaId === undefined ? {} : { analytics: { ...s.analytics, gaId } }) }));
    });

    scope.post("/admin/api/ads", session, async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const ads = parseAds(b);
      const adsenseClient = b.adsenseClient === undefined ? undefined : parseAdsenseClient(b.adsenseClient);
      return save("anúncios", (s) => ({ ...s, ads, ...(adsenseClient === undefined ? {} : { analytics: { ...s.analytics, adsenseClient } }) }));
    });

    scope.post("/admin/api/home", session, async (req) => {
      const home = parseHome((req.body ?? {}) as Record<string, unknown>);
      return save("home", (s) => ({ ...s, home: { ...s.home, ...home } }));
    });

    scope.post("/admin/api/author", session, async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const profile = parseAuthor(b, settings.current.authorProfile);
      if (b.removePhoto === true) {
        delete profile.photo;
        await removeAuthorPhoto(env.assetsDir);
      }
      return save("autor", (s) => ({ ...s, authorProfile: profile }));
    });

    scope.post("/admin/api/author-photo", session, async (req) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new WpError(415, "invalid_image", "Envie uma foto PNG, JPG ou WebP.");
      let photo: { base: string };
      try {
        photo = await storeAuthorPhoto(env.assetsDir, req.body);
      } catch {
        throw new WpError(415, "invalid_image", "Não foi possível ler a foto. Envie um PNG, JPG ou WebP válido.");
      }
      // Foto enviada antes do nome: fica guardada, sem aparecer no site até o cadastro
      const empty = parseAuthor({}, undefined);
      return save("foto do autor", (s) => ({ ...s, imageGenerator: s.imageGenerator ?? IMAGE_GENERATOR_VERSION, authorProfile: { ...(s.authorProfile ?? empty), photo } }));
    });

    scope.get("/admin/api/posts", session, async () => ({ posts: await store.listArticles() }));

    scope.post("/admin/api/posts/delete", session, async (req) => {
      const { slugs } = (req.body ?? {}) as { slugs?: unknown };
      if (!Array.isArray(slugs) || slugs.length === 0 || slugs.length > 500 || !slugs.every((s) => typeof s === "string")) {
        throw new WpError(400, "invalid_settings", "Escolha de 1 a 500 artigos.");
      }
      const { deleted, missing, failed } = await store.deletePosts(slugs);
      for (const f of failed) req.log.error({ slug: f.slug, err: f.error }, "não foi possível excluir o artigo");
      if (deleted.length) {
        req.log.info({ slugs: deleted }, "artigos excluídos pelo painel");
        builds.request(deleted.length === 1 ? `exclusão de ${deleted[0]}` : `exclusão de ${deleted.length} artigos`);
      }
      // O motivo técnico fica só no log: pode trazer caminhos do volume
      return { deleted, missing, failed: failed.map((f) => f.slug), build: builds.getStatus(), posts: await store.listArticles() };
    });

    scope.post("/admin/api/categories", session, async (req) => {
      const body = (req.body ?? {}) as { categories?: unknown };
      const merged = mergeCategories(site.categories, body.categories, settings.current.nextCategoryId, (slug) => store.postsInCategory(slug));
      return save("categorias", (s) => ({ ...s, ...merged }));
    });

    // --- Páginas fixas: editadas aqui, ficam no volume (env.volumePagesDir), por cima das de sites/<SITE>/pages ---
    const readPage = async (file: string) => {
      const raw = await readFile(path.join(env.pagesDir, file), "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const data = (m ? (YAML.parse(m[1]!) as Record<string, unknown>) : {}) ?? {};
      return { slug: file.replace(/\.md$/, ""), data, body: (m ? m[2]! : raw).replace(/^\n+/, "") };
    };
    const listPages = async () => {
      if (!existsSync(env.pagesDir)) return [];
      const files = (await readdir(env.pagesDir)).filter((f) => f.endsWith(".md")).sort();
      return Promise.all(files.map(async (f) => {
        const p = await readPage(f);
        return { slug: p.slug, title: String(p.data.title ?? p.slug), description: String(p.data.description ?? ""), body: p.body };
      }));
    };
    const checkPlaceholders = (label: string, text: string) => {
      for (const m of text.matchAll(/(?:\{\{|%7B%7B)\s*([a-z.]+)\s*(?:\}\}|%7D%7D)/gi)) {
        if (!PAGE_PLACEHOLDERS.has(m[1]!)) throw new WpError(400, "invalid_settings", `${label}: o marcador ${m[0]} não existe. Use ${[...PAGE_PLACEHOLDERS].map((k) => `{{${k}}}`).join(", ")}.`);
      }
    };

    scope.get("/admin/api/pages", session, async () => ({ pages: await listPages(), edited: env.pagesDir === env.volumePagesDir }));

    scope.post("/admin/api/pages", session, async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const slug = String(b.slug ?? "");
      // Só as páginas que já existem: o slug nunca vira caminho sem estar na lista
      const pages = await listPages();
      if (!pages.some((p) => p.slug === slug)) throw new WpError(404, "page_not_found", "Página não encontrada. Atualize a tela e tente de novo.");
      const field = (key: string, label: string, max: number) => {
        const v = b[key];
        if (typeof v !== "string") throw new WpError(400, "invalid_settings", `${label}: valor inválido.`);
        if (v.length > max) throw new WpError(400, "invalid_settings", `${label}: texto longo demais (máximo ${max} caracteres).`);
        return v;
      };
      const title = field("title", "Título", PAGE_LIMITS.title).trim();
      const description = field("description", "Descrição", PAGE_LIMITS.description).replace(/\s+/g, " ").trim();
      const body = field("body", "Texto da página", PAGE_LIMITS.body).replace(/\r\n/g, "\n").trim();
      if (!title) throw new WpError(400, "invalid_settings", "Título: preencha o título da página.");
      if (!description) throw new WpError(400, "invalid_settings", "Descrição: preencha a descrição (aparece no Google).");
      checkPlaceholders("Título", title);
      checkPlaceholders("Descrição", description);
      checkPlaceholders("Texto da página", body);
      // Primeira edição: as páginas do repositório vão para o volume, e de lá em diante valem as do volume
      if (env.pagesDir !== env.volumePagesDir) {
        if (!existsSync(env.volumePagesDir)) await cp(env.pagesDir, env.volumePagesDir, { recursive: true });
        env.pagesDir = env.volumePagesDir;
      }
      const current = await readPage(`${slug}.md`);
      const data = { ...current.data, title, description, updated: new Date().toISOString().slice(0, 10) };
      const file = path.join(env.pagesDir, `${slug}.md`);
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `---\n${YAML.stringify(data, { lineWidth: 0 })}---\n\n${body}\n`);
      await rename(tmp, file);
      await store.reloadPages();
      builds.request(`página ${slug}`);
      return { pages: await listPages(), edited: true, state: stateJson() };
    });

    // --- Reiniciar para novo domínio ---
    const resetSummary = async () => ({
      allowed: hasSiteFolder(env.projectDir),
      domain: hostOf(site.url),
      posts: store.postCount,
      uploads: await countFiles(env.uploadsDir),
      assets: await countFiles(env.assetsDir),
      trash: existsSync(env.trashDir) ? (await readdir(env.trashDir)).length : 0,
      settings: existsSync(env.settingsFile),
      pages: existsSync(env.volumePagesDir),
      cache: existsSync(env.buildCacheDir),
      // Com o prefixo igual ao SITE, os backups do domínio novo caem na mesma pasta do bucket que os do antigo
      s3PrefixWarning: Boolean(env.s3 && env.s3.prefix === env.site),
      s3: Boolean(env.s3),
    });

    scope.get("/admin/api/reset", session, async () => resetSummary());

    scope.post("/admin/api/reset", session, async (req) => {
      const summary = await resetSummary();
      // Blog sem pasta: sem o settings.json ele voltaria ao assistente, e o painel ficaria inacessível
      if (!summary.allowed) throw new WpError(409, "reset_unavailable", "Disponível só para blogs com pasta em sites/ (variável SITE preenchida).");
      if (typedHost(((req.body ?? {}) as Record<string, unknown>).confirm) !== summary.domain) {
        throw new WpError(400, "reset_confirm", `Para confirmar, digite o domínio atual exatamente: ${summary.domain}`);
      }
      let backup;
      try {
        backup = await runBackup(env, "reinicio");
      } catch (err) {
        req.log.error({ err: (err as Error).message }, "reinício cancelado: o backup falhou");
        throw new WpError(500, "reset_backup_failed", "O backup não pôde ser feito, então nada foi apagado. Veja os logs do serviço e tente de novo.");
      }
      req.log.warn({ domain: summary.domain, backup: path.basename(backup.file), posts: summary.posts }, "reinício para novo domínio: apagando o conteúdo");
      const { posts } = await store.clearContent();
      for (const dir of [env.buildCacheDir, env.trashDir, env.assetsDir, env.volumePagesDir]) await rm(dir, { recursive: true, force: true });
      await rm(env.settingsFile, { force: true });
      env.pagesDir = path.join(siteDir(env.projectDir), "pages");
      await store.reloadPages();
      settings.reload();
      await settings.update((s) => ({ ...s, resetAt: new Date().toISOString() }));
      builds.request("reinício para novo domínio");
      return {
        backup: path.basename(backup.file),
        uploaded: backup.uploaded,
        removed: { posts, uploads: summary.uploads, assets: summary.assets, trash: summary.trash },
        s3PrefixWarning: summary.s3PrefixWarning,
        state: stateJson(),
      };
    });

    // Só esconde a lista: nada muda no site, então não há publicação
    scope.post("/admin/api/checklist", session, async () => {
      await settings.update((s) => {
        const next = { ...s };
        delete next.resetAt;
        return next;
      });
      return stateJson();
    });

    const newWordbeePassword = async () => {
      const password = generateAppPassword();
      await secrets.update({ wordbeeUser: WORDBEE_USER, wordbeePasswordHash: hashPassword(password) });
      return { user: WORDBEE_USER, password };
    };
    scope.post("/admin/api/wordbee-password", session, async () => {
      if (env.passwordHash) throw new WpError(409, "managed_by_env", "A senha é definida pela variável WP_APP_PASSWORD_HASH. Troque a variável no Easypanel.");
      return newWordbeePassword();
    });

    // --- Assistente de primeiro acesso ---
    const setupAvailable = () => Boolean(env.setupToken) && !settings.isConfigured();
    const requireSetup = async (req: FastifyRequest) => {
      if (!setupAvailable()) throw new WpError(404, "setup_unavailable", "O assistente não está disponível.");
      const ip = clientIp(req);
      setupAttempts.assertAllowed(ip);
      const given = req.headers["x-setup-token"];
      if (typeof given !== "string" || !timingSafeEqual(digest(given), digest(env.setupToken))) {
        setupAttempts.fail(ip);
        throw new WpError(401, "setup_bad_token", "Código de configuração incorreto.");
      }
      setupAttempts.clear(ip);
    };

    scope.get("/admin/setup", async (_req, reply) => {
      if (!setupAvailable()) throw new WpError(404, "setup_unavailable", "O assistente não está disponível.");
      return page(reply, "setup.html");
    });

    scope.post("/admin/setup/api/check", { preHandler: requireSetup }, async () => ({ ok: true, aiConfigured: Boolean(env.anthropicApiKey), lang: "pt-BR" }));

    scope.post("/admin/setup/api/generate", { preHandler: requireSetup, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const name = String(b.name ?? "").trim();
      const niche = String(b.niche ?? "").trim();
      const lang = String(b.lang ?? "pt-BR").trim() || "pt-BR";
      if (!name || !niche) throw new WpError(400, "invalid_settings", "Informe o nome e o nicho do blog.");
      if (name.length > 80 || niche.length > 500 || !/^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/.test(lang)) throw new WpError(400, "invalid_settings", "Confira o nome, o nicho e o idioma (ex.: pt-BR).");
      if (!env.anthropicApiKey) throw new WpError(503, "ai_not_configured", "A variável ANTHROPIC_API_KEY não está definida no servidor.");
      return generateProposal({ name, niche, lang, apiKey: env.anthropicApiKey, model: env.aiModel });
    });

    scope.post("/admin/setup/api/publish", { preHandler: requireSetup }, async (req) => {
      const b = (req.body ?? {}) as { name?: unknown; lang?: unknown; adminPassword?: unknown; proposal?: SetupProposal };
      const name = String(b.name ?? "").trim().slice(0, 80);
      const lang = String(b.lang ?? "pt-BR").trim() || "pt-BR";
      const adminPassword = String(b.adminPassword ?? "");
      if (!name) throw new WpError(400, "invalid_settings", "Informe o nome do blog.");
      if (adminPassword.replace(/\s/g, "").length < 10) throw new WpError(400, "invalid_settings", "A senha do painel precisa ter pelo menos 10 caracteres.");
      const p = b.proposal;
      if (!p) throw new WpError(400, "invalid_settings", "Faltam os dados do blog.");
      const problems = validateProposal(p).filter((e) => !e.startsWith("são de"));
      if (!p.categories?.length) problems.push("inclua pelo menos uma categoria");
      if (problems.length) throw new WpError(400, "invalid_settings", `Confira: ${problems.join("; ")}.`);
      // Antes de gravar qualquer coisa: categoria removida na revisão não pode deixar link quebrado
      const home = p.home ? parseHome(p.home as unknown as Record<string, unknown>) : undefined;
      const broken = home ? brokenCategoryLinks(home, p.categories.map((c) => c.slug)) : [];
      if (broken.length) throw new WpError(400, "invalid_settings", `Estes links apontam para uma categoria que não existe: ${broken.join(", ")}.`);

      await generateBrand(path.join(env.assetsDir, "brand"), { name, tagline: p.tagline, accent: p.palette.primary });
      const brandSvgWidth = Math.round(52 + name.length * 11.5);

      // Páginas fixas do modelo no volume, com o Sobre gerado
      if (!existsSync(env.pagesDir)) await cp(path.join(siteDir(env.projectDir), "pages"), env.pagesDir, { recursive: true });
      const frontmatter = YAML.stringify({ title: `Sobre o ${name}`, description: p.tagline, schemaType: "AboutPage" }, { lineWidth: 0 });
      await writeFile(path.join(env.pagesDir, "sobre.md"), `---\n${frontmatter}---\n\n${p.about.trim()}\n`);
      await store.reloadPages();

      const password = generateAppPassword();
      await secrets.update({
        ...(env.adminPasswordHash ? {} : { adminUser: "admin", adminPasswordHash: hashPassword(adminPassword) }),
        wordbeeUser: WORDBEE_USER,
        wordbeePasswordHash: hashPassword(password),
      });

      const merged = mergeCategories([], p.categories.map(({ name: n, slug, description }) => ({ name: n, slug, description })), 2);
      // O settings.json é o último: enquanto ele não existir, o blog segue "não configurado"
      await settings.update((s) => ({
        ...s,
        configured: true,
        lang,
        tagline: p.tagline,
        description: p.tagline,
        brand: {
          ...s.brand,
          name,
          logo: { src: "/assets/brand/logo.svg", width: brandSvgWidth, height: 40 },
          favicon: "/assets/brand/favicon.svg",
          defaultImage: "/assets/brand/og-default.jpg",
          organizationLogo: "/assets/brand/logo-512.png",
          avatar: "/assets/brand/autor.webp",
          colors: p.palette,
        },
        ...(home ? { home } : {}),
        ...merged,
      }));
      builds.request("primeira publicação do assistente");
      req.log.info({ site: env.site, name }, "assistente concluído");
      return { ok: true, adminUser: env.adminPasswordHash ? env.adminUser : "admin", wordbee: { url: site.url, user: WORDBEE_USER, password } };
    });
  });
}

