/**
 * Blog "camaleão": tudo o que muda de um domínio para outro se edita no /admin,
 * e "Reiniciar para novo domínio" apaga o conteúdo com backup antes.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-camaleao-"));
process.env.SITE = "camaleao";
delete process.env.SITE_URL;
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
process.env.ADMIN_USER = "chefe";

const { hashPassword } = await import("./auth.ts");
process.env.ADMIN_PASSWORD_HASH = hashPassword("senha do painel");
const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");
const { default: site } = await import("../site.config.ts");
type Ctx = Awaited<ReturnType<typeof buildApp>>;

let ctx: Ctx;
let env: ReturnType<typeof loadEnv>;
let cookie = "";
const WP_AUTH = { authorization: "Basic " + Buffer.from("wordbee:senha do wordbee").toString("base64") };
const post = (url: string, payload: object) => ctx.app.inject({ method: "POST", url, headers: { cookie }, payload });
const state = async () => (await ctx.app.inject({ url: "/admin/api/state", headers: { cookie } })).json();
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#3366cc" } }).png().toBuffer();

before(async () => {
  env = loadEnv({
    user: "wordbee",
    passwordHash: hashPassword("senha do wordbee"),
    contentDir: path.join(tmp, "posts"),
    uploadsDir: path.join(tmp, "uploads"),
    stateFile: path.join(tmp, "data", "state.json"),
    secretsFile: path.join(tmp, "secrets.json"),
    buildCacheDir: path.join(tmp, "data", "build-cache"),
    backupDir: path.join(tmp, "backups"),
    buildMode: "none",
    serveStatic: true,
    scheduler: false,
    currentLink: path.join(tmp, "current"),
  });
  ctx = await buildApp(env, { logger: false });
  const res = await ctx.app.inject({ method: "POST", url: "/admin/api/login", payload: { user: "chefe", password: "senha do painel" } });
  assert.equal(res.statusCode, 200, res.body);
  cookie = String(res.headers["set-cookie"]).split(";")[0]!;
});

after(async () => {
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("modelo neutro", () => {
  test("sites/camaleao nasce sem texto de viagem e com o ticker desligado", () => {
    const files = [path.resolve("sites/camaleao/site.config.ts"), ...readdirSync("sites/camaleao/pages").map((f) => path.resolve("sites/camaleao/pages", f))];
    for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /viag|viaj|passage|roteir|câmbio|asas do mundo|rota leve|TODO: escreva/i, f);
    assert.equal(site.ticker.enabled, false);
    assert.equal(site.article.authorBox.kicker, "Quem escreve");
  });
});

describe("tudo pelo /admin", () => {
  test("marca: frase e descrição do nicho", async () => {
    const res = await post("/admin/api/brand", { name: "Horta Fácil", tagline: "Plantas em casa sem segredo", description: "Guias para cultivar ervas e hortaliças em apartamento.", colors: {} });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(site.tagline, "Plantas em casa sem segredo");
    assert.equal(site.description, "Guias para cultivar ervas e hortaliças em apartamento.");
    // O nome novo entra no lugar do antigo nos textos do modelo
    assert.equal(site.authors[site.defaultAuthor]!.name, "Equipe Horta Fácil");
  });

  test("domínio: o do painel vale mais que o da config; vazio volta ao anterior", async () => {
    const original = site.url;
    assert.equal((await post("/admin/api/domain", { siteUrl: "https://horta.com.br/caminho" })).statusCode, 400);
    const res = await post("/admin/api/domain", { siteUrl: "Horta.com.br/" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(site.url, "https://horta.com.br");
    assert.equal(res.json().domain.saved, "https://horta.com.br");
    // A API do Wordbee devolve os links no domínio novo
    const cats = await ctx.app.inject({ url: "/wp-json/wp/v2/categories" });
    assert.match(cats.json()[0].link, /^https:\/\/horta\.com\.br\/category\//);
    await post("/admin/api/domain", { siteUrl: "" });
    assert.equal(site.url, original);
    await post("/admin/api/domain", { siteUrl: "horta.com.br" });
  });

  test("textos: contato, responsável, cookies, afiliados e caixa do autor", async () => {
    assert.equal((await post("/admin/api/texts", { contactEmail: "sem-arroba" })).statusCode, 400);
    const res = await post("/admin/api/texts", { contactEmail: "ola@horta.com.br", legalOwner: "Horta Fácil Ltda.", legalCity: "Curitiba, PR", cookies: "Usamos cookies na horta.", affiliateNotice: "", authorBoxKicker: "Quem cuida da horta" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(site.contact.email, "ola@horta.com.br");
    assert.deepEqual(site.legal, { owner: "Horta Fácil Ltda.", city: "Curitiba, PR" });
    assert.equal(site.cookies.text, "Usamos cookies na horta.");
    assert.equal(site.article.affiliateNotice.enabled, false);
    assert.equal(site.article.authorBox.kicker, "Quem cuida da horta");
  });

  test("IDs do AdSense e do Analytics, com formato conferido", async () => {
    assert.equal((await post("/admin/api/ads", { adsenseClient: "pub-123" })).statusCode, 400);
    assert.equal((await post("/admin/api/tracking", { gaId: "UA-1" })).statusCode, 400);
    assert.equal((await post("/admin/api/ads", { adsenseClient: "ca-pub-1234567890123456", adsTxt: "google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0" })).statusCode, 200);
    assert.equal((await post("/admin/api/tracking", { gaId: "g-abc123" })).statusCode, 200);
    assert.deepEqual(site.analytics, { gaId: "G-ABC123", adsenseClient: "ca-pub-1234567890123456" });
  });

  test("imagem de compartilhamento: recortada em 1200 × 630, sem sair do volume", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/admin/api/share-image", headers: { cookie, "content-type": "image/png" }, payload: await png(2000, 2000) });
    assert.equal(res.statusCode, 200, res.body);
    const src = res.json().shareImage as string;
    assert.match(src, /^\/assets\/og-[0-9a-f]{10}\.jpg$/);
    const meta = await sharp(path.join(env.assetsDir, path.basename(src))).metadata();
    assert.deepEqual([meta.width, meta.height], [1200, 630]);
    assert.equal(site.seo.defaultImage.src, src);
  });

  test("páginas fixas: a primeira edição leva todas para o volume; marcador desconhecido é recusado", async () => {
    const repoSobre = readFileSync("sites/camaleao/pages/sobre.md", "utf8");
    const list = (await ctx.app.inject({ url: "/admin/api/pages", headers: { cookie } })).json();
    assert.equal(list.edited, false);
    assert.ok(list.pages.some((p: { slug: string }) => p.slug === "contato"));

    const bad = await post("/admin/api/pages", { slug: "sobre", title: "Sobre", description: "x", body: "Fale com {{autor.email}}" });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().message, /autor\.email/);
    assert.equal((await post("/admin/api/pages", { slug: "../segredo", title: "x", description: "x", body: "x" })).statusCode, 404);

    const res = await post("/admin/api/pages", { slug: "sobre", title: "Sobre a {{site.name}}", description: "Quem cuida da horta.", body: "Escreva para {{contact.email}}." });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().edited, true);
    assert.equal(env.pagesDir, env.volumePagesDir);
    const saved = readFileSync(path.join(env.volumePagesDir, "sobre.md"), "utf8");
    assert.match(saved, /title: Sobre a \{\{site\.name\}\}/);
    assert.match(saved, /schemaType: AboutPage/);
    assert.match(saved, /Escreva para \{\{contact\.email\}\}\./);
    // As outras páginas foram junto, e o repositório não mudou
    assert.ok(existsSync(path.join(env.volumePagesDir, "termos-de-uso.md")));
    assert.equal(readFileSync("sites/camaleao/pages/sobre.md", "utf8"), repoSobre);
    // Os 301 continuam vindo do repositório
    assert.equal(env.redirectsFile, path.resolve("sites/camaleao/redirects.txt"));
  });

  test("categorias do nicho: cria e exclui a que não tem artigos", async () => {
    const res = await post("/admin/api/categories", { categories: [{ name: "Ervas", slug: "ervas", description: "Manjericão, salsinha e cia." }, { name: "Hortaliças", slug: "hortalicas", description: "" }] });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(site.categories.map((c) => c.slug), ["ervas", "hortalicas"]);
  });
});

describe("reiniciar para novo domínio", () => {
  test("resumo e confirmação pelo domínio atual", async () => {
    // Conteúdo do domínio atual: post com imagem, cache, lixeira e foto do autor
    const media = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/media", headers: { ...WP_AUTH, "content-type": "image/png", "content-disposition": 'attachment; filename="horta.png"' }, payload: await png(800, 600) });
    assert.equal(media.statusCode, 201, media.body);
    const created = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: WP_AUTH, payload: { title: "Como plantar manjericão", content: "<p>Texto.</p>", status: "publish", categories: [site.categories[0]!.id], featured_media: media.json().id } });
    assert.equal(created.statusCode, 201, created.body);
    await mkdir(env.buildCacheDir, { recursive: true });
    await writeFile(path.join(env.buildCacheDir, "cotacao.json"), "{}");
    await mkdir(path.join(env.trashDir, "2026-11-01-antigo"), { recursive: true });
    await writeFile(env.secretsFile, JSON.stringify({ adminUser: "x", adminPasswordHash: "y" }));

    const summary = (await ctx.app.inject({ url: "/admin/api/reset", headers: { cookie } })).json();
    assert.equal(summary.domain, "horta.com.br");
    assert.equal(summary.allowed, true);
    assert.equal(summary.posts, 1);
    assert.ok(summary.uploads > 0);
    assert.equal(summary.settings, true);
    assert.equal(summary.s3PrefixWarning, false);

    for (const confirm of ["", "outro.com.br", "horta.com"]) {
      const res = await post("/admin/api/reset", { confirm });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().message, /horta\.com\.br/);
    }
    // Nada foi apagado
    assert.equal(ctx.store.postCount, 1);
    assert.ok(existsSync(env.settingsFile));
  });

  test("faz o backup, apaga o conteúdo e a personalização e mantém login, senhas e numeração", async () => {
    const stateBefore = readFileSync(env.stateFile, "utf8");
    const res = await post("/admin/api/reset", { confirm: "https://Horta.com.br/" });
    assert.equal(res.statusCode, 200, res.body);
    const r = res.json();

    // Backup com tudo, fora da retenção automática (só blog-*.tar.gz é apagado)
    assert.match(r.backup, /^reinicio-camaleao-\d{8}T\d{6}Z\.tar\.gz$/);
    const listing = execFileSync("tar", ["-tzf", path.join(env.backupDir, r.backup)], { encoding: "utf8" });
    for (const entry of ["content/como-plantar-manjericao.md", "settings.json", "assets/", "pages/sobre.md", "uploads/"]) assert.ok(listing.includes(entry), entry);
    assert.deepEqual(r.removed.posts, 1);

    // Apagados
    assert.equal(ctx.store.postCount, 0);
    assert.deepEqual(readdirSync(env.contentDir), []);
    assert.deepEqual(readdirSync(env.uploadsDir), []);
    for (const gone of [env.buildCacheDir, env.trashDir, env.assetsDir, env.volumePagesDir]) assert.ok(!existsSync(gone), gone);

    // Mantidos
    assert.ok(existsSync(env.secretsFile));
    assert.equal(readFileSync(env.stateFile, "utf8"), stateBefore);
    assert.equal(env.pagesDir, path.resolve("sites/camaleao/pages"));
    assert.equal((await ctx.app.inject({ url: "/wp-json/wp/v2/users/me", headers: WP_AUTH })).statusCode, 200);
    assert.equal((await ctx.app.inject({ url: "/admin/api/state", headers: { cookie } })).statusCode, 200);

    // O site volta ao modelo neutro
    assert.equal(site.name, "Novo Blog");
    assert.equal(site.url, "https://camaleao.example.com");
    assert.equal(site.tagline, "Artigos e guias práticos");
    assert.deepEqual(site.categories.map((c) => c.slug), ["geral"]);
    assert.equal(site.analytics.adsenseClient, "");
    assert.equal(site.article.affiliateNotice.enabled, true);
    assert.equal(site.logoDark, undefined);

    // O settings.json novo só tem a marca do reinício: o resto vem do repositório
    const saved = JSON.parse(readFileSync(env.settingsFile, "utf8"));
    assert.ok(saved.resetAt);
    assert.equal(saved.siteUrl, undefined);
  });

  test("checklist do que preencher, que some ao concluir", async () => {
    const s = await state();
    assert.ok(Array.isArray(s.checklist));
    assert.deepEqual(s.checklist.map((i: { screen: string }) => i.screen), ["marca", "marca", "dominio", "categorias", "paginas", "autor", "anuncios", "rastreamento"]);
    assert.ok(s.checklist.every((i: { done: boolean }) => !i.done));

    await post("/admin/api/domain", { siteUrl: "nova-horta.com.br" });
    assert.equal((await state()).checklist.find((i: { screen: string }) => i.screen === "dominio").done, true);

    const hidden = await post("/admin/api/checklist", {});
    assert.equal(hidden.statusCode, 200);
    assert.equal(hidden.json().checklist, null);
    assert.equal(JSON.parse(readFileSync(env.settingsFile, "utf8")).resetAt, undefined);
  });

  test("aviso quando o prefixo do S3 é igual ao SITE", async () => {
    const saved = env.s3;
    env.s3 = { endpoint: "https://s3.example", region: "us-east-1", bucket: "b", accessKey: "a", secretKey: "s", prefix: "camaleao" };
    try {
      assert.equal((await ctx.app.inject({ url: "/admin/api/reset", headers: { cookie } })).json().s3PrefixWarning, true);
    } finally {
      env.s3 = saved;
    }
  });
});
