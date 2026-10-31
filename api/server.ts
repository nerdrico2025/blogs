/**
 * Servidor do blog: API compatível com o subconjunto da WordPress REST API usado pelo Wordbee
 *   GET  /wp-json/wp/v2/users/me
 *   GET  /wp-json/wp/v2/categories
 *   POST /wp-json/wp/v2/media   (corpo binário)
 *   POST /wp-json/wp/v2/posts   (JSON)
 * mais GET /health e, se SERVE_STATIC não for "false", o site estático e as imagens (api/static.ts).
 * Ver docs/wordbee-integracao.md.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import site from "../site.config.ts";
import { adminCredentials, registerAdmin } from "./admin.ts";
import { Authenticator } from "./auth.ts";
import { clientIp } from "./client-ip.ts";
import { registerStatic } from "./static.ts";
import { BuildQueue } from "./build-queue.ts";
import type { ApiEnv } from "./env.ts";
import { badParam, WpError } from "./errors.ts";
import { SecretStore } from "./secrets.ts";
import { SettingsStore } from "./settings-store.ts";
import { Store, type PostRecord } from "./store.ts";
import { findCategory } from "../shared/settings.ts";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const WP = "/wp-json/wp/v2";

/** O WP aceita `title: "x"` ou `title: { raw: "x" }`. */
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "raw" in value && typeof (value as { raw: unknown }).raw === "string") {
    return (value as { raw: string }).raw;
  }
  return undefined;
}

function filenameFrom(header: string | undefined): string {
  if (!header) return "imagem";
  const star = header.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ""));
    } catch {}
  }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1]!.trim() : "imagem";
}

function postJson(post: PostRecord, store: Store) {
  const category = findCategory(site.categories, post.category);
  return {
    id: post.id,
    date: post.date,
    date_gmt: post.date.replace(/Z$/, ""),
    slug: post.slug,
    status: post.status,
    type: "post",
    link: store.postLink(post.slug),
    title: { rendered: post.title },
    excerpt: { rendered: post.excerpt ? `<p>${post.excerpt}</p>` : "" },
    featured_media: post.featuredMedia,
    categories: category ? [category.id] : [],
    tags: [],
  };
}

export interface App {
  app: FastifyInstance;
  store: Store;
  builds: BuildQueue;
}

export async function buildApp(env: ApiEnv, opts: { logger?: boolean } = {}): Promise<App> {
  const app = Fastify({
    logger: opts.logger === false ? false : { redact: ["req.headers.authorization"] },
    // Confia nos N proxies mais próximos (Traefik = 1); o IP do visitante vem do X-Forwarded-For
    trustProxy: (_addr: string, hop: number) => hop < env.trustProxyHops,
    bodyLimit: 2 * 1024 * 1024,
  });
  const store = new Store(env);
  await store.init();
  const builds = new BuildQueue(env, app.log);
  const settings = new SettingsStore(env.settingsFile, env.projectDir);
  const secrets = new SecretStore(env.secretsFile);
  builds.setGate(() => settings.isConfigured());
  // WP_USER e WP_APP_PASSWORD_HASH têm prioridade sobre a senha gerada
  const auth = new Authenticator(() =>
    env.passwordHash
      ? { user: env.user, passwordHash: env.passwordHash }
      : { user: secrets.data.wordbeeUser ?? "wordbee", passwordHash: secrets.data.wordbeePasswordHash ?? "" }
  );
  if (settings.isConfigured() && !env.passwordHash && !secrets.data.wordbeePasswordHash) {
    app.log.warn("nenhuma senha do Wordbee definida: use WP_APP_PASSWORD_HASH ou gere uma no /admin");
  }
  if (!adminCredentials(env, secrets).passwordHash && settings.isConfigured()) app.log.info("/admin desligado: defina ADMIN_USER e ADMIN_PASSWORD_HASH");

  // Rate limit só nas rotas da API (o site estático não entra na conta)
  await app.register(rateLimit, {
    global: false,
    keyGenerator: clientIp,
    errorResponseBuilder: (_req, ctx) =>
      new WpError(429, "rest_too_many_requests", `Muitas requisições. Tente de novo em ${Math.ceil(ctx.ttl / 1000)} s.`),
  });

  app.addContentTypeParser(IMAGE_TYPES, { parseAs: "buffer", bodyLimit: env.maxUploadBytes }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof WpError) return reply.status(err.status).send(err.toJSON());
    const e = err as { code?: string; statusCode?: number; message: string };
    if (e.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.status(413).send(new WpError(413, "rest_upload_file_too_big", `Arquivo maior que ${Math.round(env.maxUploadBytes / 1048576)} MB.`).toJSON());
    }
    if (e.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.status(415).send(new WpError(415, "rest_upload_invalid_type", "Tipo de conteúdo não suportado.").toJSON());
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send(new WpError(e.statusCode, "rest_invalid_request", e.message).toJSON());
    }
    req.log.error({ err }, "erro interno");
    return reply.status(500).send(new WpError(500, "rest_internal_error", "Erro interno.").toJSON());
  });

  app.setNotFoundHandler((req, reply) => {
    if (app.blogNotFound && !req.url.startsWith("/wp-json") && (req.method === "GET" || req.method === "HEAD")) return app.blogNotFound(reply);
    return reply.status(404).send(new WpError(404, "rest_no_route", "Nenhuma rota correspondente à URL e ao método da requisição.").toJSON());
  });

  // Cabeçalhos de segurança em todas as respostas (o HTTPS fica no Traefik)
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  const limited = { rateLimit: { max: env.rateLimitPerMinute, timeWindow: "1 minute" } };
  /** Até o assistente terminar, os endpoints do Wordbee respondem 503. */
  const requireConfigured = async () => {
    if (!settings.isConfigured()) throw new WpError(503, "rest_site_not_configured", "O blog ainda não foi configurado. Conclua o assistente em /admin/setup.");
  };
  const requireAuth = [requireConfigured, async (req: FastifyRequest) => auth.check(req.headers.authorization, clientIp(req))];
  /** Rotas públicas no WP: sem credencial passam; credencial errada dá 401, como no WP. */
  const optionalAuth = [
    requireConfigured,
    async (req: FastifyRequest) => {
      if (req.headers.authorization) auth.check(req.headers.authorization, clientIp(req));
    },
  ];

  app.get("/health", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return {
      status: "ok",
      site: env.site,
      posts: store.postCount,
      configured: settings.isConfigured(),
      build: builds.getStatus(),
    };
  });

  /**
   * Pede um build sem publicar nada (ex.: pelo console do container: curl -X POST localhost:$PORT/internal/rebuild).
   * Só aceita conexões locais diretas: requisições vindas do Traefik ou do Nginx chegam de outro IP
   * ou com X-Forwarded-For e recebem 404.
   */
  app.post("/internal/rebuild", async (req, reply) => {
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
    if (!local || req.headers["x-forwarded-for"]) throw new WpError(404, "rest_no_route", "Nenhuma rota correspondente à URL e ao método da requisição.");
    builds.request(String((req.query as Record<string, unknown>).reason ?? "manual"));
    return reply.status(202).send({ queued: true });
  });

  app.get(`${WP}/users/me`, { preHandler: requireAuth, config: limited }, async () => {
    const author = site.authors[site.defaultAuthor]!;
    return { id: 1, name: author.name, slug: site.defaultAuthor, url: site.url, description: author.bio, link: `${site.url}/sobre/`, roles: ["administrator"] };
  });

  app.get(`${WP}/categories`, { preHandler: optionalAuth, config: limited }, async () =>
    [...site.categories]
      .sort((a, b) => a.name.localeCompare(b.name, site.lang))
      .map((c) => ({
        id: c.id,
        count: store.countByCategory(c.slug),
        description: c.description,
        link: `${site.url}/category/${c.slug}/`,
        name: c.name,
        slug: c.slug,
        taxonomy: "category",
        parent: 0,
      }))
  );

  app.post(`${WP}/media`, { preHandler: requireAuth, config: limited }, async (req, reply) => {
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type) || !Buffer.isBuffer(req.body)) {
      throw new WpError(415, "rest_upload_invalid_type", "Envie a imagem como corpo binário (image/jpeg, image/png ou image/webp).");
    }
    if (req.body.length === 0) throw new WpError(400, "rest_upload_no_data", "Nenhum dado recebido.");
    const filename = filenameFrom(req.headers["content-disposition"]);
    const { record, meta } = await store.saveMedia(req.body, filename);
    const sourceUrl = site.url + record.src;
    req.log.info({ mediaId: record.id, src: record.src }, "mídia salva");
    return reply.status(201).send({
      id: record.id,
      date: record.createdAt,
      slug: record.src.split("/").pop()!.replace(/\.[a-z0-9]+$/, ""),
      type: "attachment",
      link: sourceUrl,
      title: { rendered: filename },
      alt_text: "",
      media_type: "image",
      mime_type: record.mime,
      source_url: sourceUrl,
      media_details: { width: meta.width, height: meta.height, file: record.src.replace("/wp-content/uploads/", "") },
    });
  });

  app.post(`${WP}/posts`, { preHandler: requireAuth, config: limited }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = text(body.title);
    const content = text(body.content);
    if (title === undefined) throw badParam("title", "Envie o título.");
    if (content === undefined) throw badParam("content", "Envie o conteúdo.");

    const statusIn = body.status === undefined ? "draft" : String(body.status);
    if (statusIn === "future") throw badParam("status", "Agendamento (future) não é suportado; publique na hora.");
    if (!["publish", "draft", "pending", "private"].includes(statusIn)) throw badParam("status", `Status desconhecido: ${statusIn}.`);
    const status = statusIn === "publish" ? "publish" : "draft";

    let categoryId: number | undefined;
    if (body.categories !== undefined) {
      const cats = Array.isArray(body.categories) ? body.categories : [body.categories];
      if (cats.length > 1) throw badParam("categories", "Envie no máximo uma categoria.");
      if (cats.length === 1) {
        categoryId = Number(cats[0]);
        if (!Number.isInteger(categoryId)) throw badParam("categories", "O id da categoria precisa ser inteiro.");
      }
    }
    const featured = body.featured_media === undefined || body.featured_media === 0 ? undefined : Number(body.featured_media);
    if (featured !== undefined && !Number.isInteger(featured)) throw badParam("featured_media", "O id da mídia precisa ser inteiro.");

    const { post, created } = await store.createPost({
      title,
      content,
      status,
      excerpt: text(body.excerpt),
      slug: typeof body.slug === "string" ? body.slug : undefined,
      categoryId,
      featuredMedia: featured,
    });
    req.log.info({ postId: post.id, slug: post.slug, status: post.status, created }, created ? "post criado" : "post repetido; devolvendo o existente");
    if (created) builds.request(`post ${post.id} (${post.slug})`);
    return reply.status(created ? 201 : 200).send(postJson(post, store));
  });

  await registerAdmin(app, { env, store, builds, settings, secrets });
  if (env.serveStatic) await registerStatic(app, env, () => settings.isConfigured());

  return { app, store, builds };
}
