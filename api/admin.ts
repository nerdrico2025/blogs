/**
 * /admin: configurações do blog, com login próprio, e /admin/setup: assistente de primeiro acesso.
 * Plugin isolado: os parsers de corpo daqui não valem para os 4 endpoints do Wordbee.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import YAML from "yaml";
import site from "../site.config.ts";
import { generateBrand } from "../scripts/lib/brand.ts";
import { AD_POSITIONS, contrastWarnings, type Settings } from "../shared/settings.ts";
import { siteDir } from "../src/lib/site-id.ts";
import { Attempts, Authenticator, generateAppPassword, hashPassword, isValidHash } from "./auth.ts";
import type { BuildQueue } from "./build-queue.ts";
import { clientIp } from "./client-ip.ts";
import type { ApiEnv } from "./env.ts";
import { WpError } from "./errors.ts";
import type { SecretStore } from "./secrets.ts";
import { generateProposal, validateProposal, type SetupProposal } from "./setup-ai.ts";
import { mergeCategories, parseAds, parseColors, parseTracking, type SettingsStore } from "./settings-store.ts";
import type { Store } from "./store.ts";

const COOKIE = "blog_admin";
const SESSION_MS = 12 * 3600 * 1000;
const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "admin-ui");
const UI_FILES: Record<string, string> = { "admin.css": "text/css", "admin.js": "text/javascript", "color.js": "text/javascript", "setup.js": "text/javascript" };
const digest = (s: string) => createHash("sha256").update(s).digest();
const WORDBEE_USER = "wordbee";

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
        url: site.url,
        logo: site.logo.src,
        favicon: site.favicon,
        colors: { primary: c.accent, highlight: site.theme.highlight ?? c.accent, callout: c.calloutFrom },
        warnings: contrastWarnings({ primary: c.accent, highlight: site.theme.highlight, callout: c.calloutFrom }),
        tracking: { gtmId: s.tracking?.gtmId ?? "", headCode: s.tracking?.headCode ?? "", bodyCode: s.tracking?.bodyCode ?? "" },
        ads: { headScript: s.ads?.headScript ?? "", adsTxt: s.ads?.adsTxt ?? site.adsTxt.join("\n"), slots: s.ads?.slots ?? {} },
        positions: AD_POSITIONS,
        categories: site.categories,
        wordbee: { managedByEnv: Boolean(env.passwordHash), user: env.passwordHash ? env.user : secrets.data.wordbeeUser ?? WORDBEE_USER, hasPassword: Boolean(env.passwordHash || secrets.data.wordbeePasswordHash) },
        build: builds.getStatus(),
        maxUploadBytes: env.maxUploadBytes,
      };
    };

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
      const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
      return save("marca", (s) => ({ ...s, brand: { ...s.brand, name, colors } }));
    });

    const imageUpload = (kind: "logo" | "favicon") => async (req: FastifyRequest) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new WpError(415, "invalid_image", "Envie uma imagem PNG, JPG, WebP ou SVG.");
      await mkdir(env.assetsDir, { recursive: true });
      const hash = digest(req.body.toString("base64")).toString("hex").slice(0, 10);
      try {
        const input = sharp(req.body, { failOn: "error", limitInputPixels: 50_000_000 }).rotate();
        if (kind === "logo") {
          const name = `logo-${hash}.webp`;
          const out = await input.resize({ height: 160, withoutEnlargement: true }).webp({ quality: 85 }).toFile(path.join(env.assetsDir, name));
          // Exibido com 40 px de altura; o arquivo maior serve para telas de alta densidade
          const logo = { src: `/assets/${name}`, width: Math.round((out.width / out.height) * 40), height: 40 };
          return await save("logotipo", (s) => ({ ...s, brand: { ...s.brand, logo } }));
        }
        const name = `favicon-${hash}.png`;
        await input.resize(64, 64, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path.join(env.assetsDir, name));
        return await save("favicon", (s) => ({ ...s, brand: { ...s.brand, favicon: `/assets/${name}` } }));
      } catch (err) {
        if (err instanceof WpError) throw err;
        throw new WpError(415, "invalid_image", "Não foi possível ler a imagem. Envie um PNG, JPG, WebP ou SVG válido.");
      }
    };
    scope.post("/admin/api/logo", session, imageUpload("logo"));
    scope.post("/admin/api/favicon", session, imageUpload("favicon"));

    scope.post("/admin/api/tracking", session, async (req) => {
      const tracking = parseTracking((req.body ?? {}) as Record<string, unknown>);
      return save("rastreamento", (s) => ({ ...s, tracking }));
    });

    scope.post("/admin/api/ads", session, async (req) => {
      const ads = parseAds((req.body ?? {}) as Record<string, unknown>);
      return save("anúncios", (s) => ({ ...s, ads }));
    });

    scope.post("/admin/api/categories", session, async (req) => {
      const body = (req.body ?? {}) as { categories?: unknown };
      const merged = mergeCategories(site.categories, body.categories, settings.current.nextCategoryId);
      return save("categorias", (s) => ({ ...s, ...merged }));
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
        author: { name: p.authorName, bio: p.authorBio },
        ...merged,
      }));
      builds.request("primeira publicação do assistente");
      req.log.info({ site: env.site, name }, "assistente concluído");
      return { ok: true, adminUser: env.adminPasswordHash ? env.adminUser : "admin", wordbee: { url: site.url, user: WORDBEE_USER, password } };
    });
  });
}

