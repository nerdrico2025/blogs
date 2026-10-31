/**
 * Ponta a ponta, como em produção: salva pelas rotas do painel, roda o build real do Astro,
 * publica a release e lê o que foi publicado. Usa o blog asasdomundo.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-brand-"));
process.env.SITE = "asasdomundo";
process.env.SITE_URL = "https://blog.example";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
process.env.ADMIN_USER = "chefe";
const { hashPassword } = await import("./auth.ts");
process.env.ADMIN_PASSWORD_HASH = hashPassword("senha ficticia");
const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
let cookie = "";
const current = path.join(tmp, "current");
const page = () => readFileSync(path.join(current, "index.html"), "utf8");
const release = () => readlinkSync(current);
const send = (url: string, type: string, payload: Buffer) => ctx.app.inject({ method: "POST", url, headers: { cookie, "content-type": type }, payload });
const image = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: "#c33" } });

before(async () => {
  ctx = await buildApp(
    loadEnv({
      user: "wordbee",
      passwordHash: hashPassword("outra"),
      contentDir: path.join(tmp, "posts"),
      uploadsDir: path.join(tmp, "uploads"),
      stateFile: path.join(tmp, "state.json"),
      secretsFile: path.join(tmp, "secrets.json"),
      buildCacheDir: path.join(tmp, "build-cache"),
      releasesDir: path.join(tmp, "releases"),
      currentLink: current,
      buildMode: "release",
      buildDebounceMs: 0,
      serveStatic: true,
      scheduler: false,
    }),
    { logger: false }
  );
  const login = await ctx.app.inject({ method: "POST", url: "/admin/api/login", payload: { user: "chefe", password: "senha ficticia" } });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});

after(async () => {
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("cores salvas no painel chegam ao site publicado", () => {
  test("as três cores: settings.json, nova release, variáveis e componentes", { timeout: 180_000 }, async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/admin/api/brand", headers: { cookie }, payload: { name: "", colors: { primary: "#a11d33", highlight: "#7a3e9d", callout: "#b4540a" } } });
    assert.equal(res.statusCode, 200, res.body);
    await ctx.builds.drain();

    const settings = JSON.parse(readFileSync(process.env.SETTINGS_FILE!, "utf8"));
    assert.deepEqual(settings.brand.colors, { primary: "#a11d33", highlight: "#7a3e9d", callout: "#b4540a" });

    assert.equal(ctx.builds.getStatus().lastBuild?.ok, true, ctx.builds.getStatus().lastBuild?.error);
    assert.ok(release().startsWith(path.join(tmp, "releases")), "publicou uma release do volume");

    const html = page();
    const cssVar = (name: string) => new RegExp(`[;{]--${name}:([^;}]+)`).exec(html)?.[1];
    assert.equal(cssVar("cor-principal"), "#a11d33");
    assert.equal(cssVar("cor-destaque"), "#7a3e9d");
    assert.equal(cssVar("cor-cartao"), "#b4540a");
    for (const old of ["#1363df", "#174c3c", "#ffcd2a"]) assert.ok(!html.includes(old), `cor padrão ${old} não sobra`);

    /** Os elementos estão na página publicada e a regra de cada um consome a variável certa. */
    const rule = (selector: string) => {
      const start = html.indexOf(`${selector}{`);
      assert.ok(start >= 0, `regra ${selector}`);
      return html.slice(start, html.indexOf("}", start));
    };
    const assertPrimaryButton = (css: string) => {
      assert.match(css, /background:var\(--cor-principal\)/);
      assert.match(css, /[;{]color:var\(--cor-principal-texto\)/);
    };
    assert.match(html, /class="post-cat"|<a[^>]*class="kicker"|class="kicker"/, "etiqueta");
    assert.match(rule(".kicker"), /color:var\(--cor-destaque-legivel\)/);
    assert.match(rule(".post-cat"), /color:var\(--cor-destaque-legivel\)/);
    assert.match(html, /class="search-form"/, "busca");
    assertPrimaryButton(rule(".search-form button"));
    assert.match(html, /class="btn btn-accent btn-block"[^>]*>Ver todos os recursos/, "Ver todos os recursos");
    assertPrimaryButton(rule(".btn-accent"));
    assert.match(html, /cc-accept/, "aceitar cookies");
    assertPrimaryButton(rule(".cc-accept"));
    assert.match(html, /class="callout-card/, "cartão da lateral");
    assert.match(rule(".callout-card"), /var\(--cor-cartao\) 0%/);
  });

  test("uma nova cor gera outra release e substitui a anterior", { timeout: 180_000 }, async () => {
    const before = release();
    await ctx.app.inject({ method: "POST", url: "/admin/api/brand", headers: { cookie }, payload: { name: "", colors: { primary: "#0b6e4f", highlight: "#7a3e9d", callout: "#b4540a" } } });
    await ctx.builds.drain();
    assert.notEqual(release(), before);
    assert.ok(page().includes("--cor-principal:#0b6e4f"));
    assert.ok(!page().includes("#a11d33"));
    const res = await ctx.app.inject({ url: "/" });
    assert.equal(res.headers["cache-control"], "public, max-age=0, must-revalidate", "o HTML sempre revalida");
    assert.ok(res.body.includes("--cor-principal:#0b6e4f"), "o servidor entrega a release nova");
  });
});

describe("cor do cabeçalho publicada", () => {
  const brand = (header?: string) => ctx.app.inject({ method: "POST", url: "/admin/api/brand", headers: { cookie }, payload: { name: "", colors: { primary: "#a11d33", ...(header ? { header } : {}) } } });
  const cssVar = (name: string) => new RegExp(`[;{]--${name}:([^;}]+)`).exec(page())?.[1];
  const savedHeader = () => JSON.parse(readFileSync(process.env.SETTINGS_FILE!, "utf8")).brand.colors.header;
  const headerImg = () => {
    const src = /class="?logo"?[^>]*>\s*<img[^>]*?src="?([^"\s>]+)/.exec(page())?.[1];
    assert.ok(src, "imagem do logotipo no cabeçalho");
    return src;
  };

  test("fundo escuro, versão clara e volta ao padrão", { timeout: 300_000 }, async () => {
    assert.equal((await brand("#0B1F3A")).statusCode, 200);
    await ctx.builds.drain();
    assert.equal(savedHeader(), "#0b1f3a");
    assert.equal(cssVar("cor-cabecalho"), "#0b1f3a");
    assert.equal(cssVar("cor-cabecalho-texto"), "#ffffff");
    assert.match(page(), /\.site-header\{[^}]*background:var\(--cor-cabecalho\)/);
    assert.match(page(), /\.nav a\{[^}]*color:var\(--cor-cabecalho-texto\)/);
    const normal = headerImg();
    assert.doesNotMatch(String(normal), /logo-dark/, "sem versão clara, a imagem não muda");

    const dark = await send("/admin/api/logo-dark", "image/png", await image(400, 100).png().toBuffer());
    assert.equal(dark.statusCode, 200, dark.body);
    assert.match(dark.json().logoDark, /^\/assets\/logo-dark-[0-9a-f]+\.webp$/);
    await ctx.builds.drain();
    assert.match(String(headerImg()), /logo-dark/, "fundo escuro usa a versão clara");

    await brand("#ebb038");
    await ctx.builds.drain();
    assert.equal(cssVar("cor-cabecalho-texto"), "#000000");
    assert.doesNotMatch(String(headerImg()), /logo-dark/, "fundo claro usa o logotipo normal");

    await brand("#FFFFFF");
    await ctx.builds.drain();
    assert.equal(savedHeader(), undefined, "o padrão não é gravado");
    assert.equal(cssVar("cor-cabecalho"), "#ffffff");
  });
});

describe("favicon enviado no painel", () => {
  const dims = async (data: Buffer) => {
    const m = await sharp(data).metadata();
    return [m.format, m.width, m.height];
  };

  test("WebP de entrada: gera ICO e PNG, nunca WebP, com ?v= publicado", { timeout: 180_000 }, async () => {
    const input = await image(600, 600).webp().toBuffer();
    const res = await send("/admin/api/favicon", "image/webp", input);
    assert.equal(res.statusCode, 200, res.body);
    await ctx.builds.drain();

    const assets = process.env.ASSETS_DIR!;
    for (const size of [32, 192, 512]) assert.deepEqual(await dims(readFileSync(path.join(assets, `favicon-${size}.png`))), ["png", size, size]);

    const ico = await ctx.app.inject({ url: "/favicon.ico" });
    assert.equal(ico.statusCode, 200);
    assert.equal(ico.headers["content-type"], "image/x-icon");
    assert.equal(ico.headers["cache-control"], "public, max-age=86400");
    assert.doesNotMatch(String(ico.headers["cache-control"]), /immutable/);
    assert.deepEqual([...ico.rawPayload.subarray(0, 8)], [0, 0, 1, 0, 1, 0, 48, 48], "cabeçalho ICO de 48 px");
    assert.deepEqual(await dims(ico.rawPayload.subarray(22)), ["png", 48, 48]);

    const apple = await ctx.app.inject({ url: "/apple-touch-icon.png" });
    assert.equal(apple.statusCode, 200);
    assert.equal(apple.headers["content-type"], "image/png");
    assert.deepEqual(await dims(apple.rawPayload), ["png", 180, 180]);
    assert.equal((await sharp(apple.rawPayload).metadata()).hasAlpha, false, "o iOS pintaria a transparência de preto");

    const html = page();
    const v = /\/favicon\.ico\?v=([0-9a-f]{10})/.exec(html)?.[1];
    assert.ok(v, "ICO com versão");
    assert.ok(html.includes(`<link rel="icon" href="/favicon.ico?v=${v}" sizes="48x48">`));
    assert.ok(html.includes(`<link rel="icon" type="image/png" sizes="192x192" href="/assets/favicon-192.png?v=${v}">`));
    assert.ok(html.includes(`<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${v}">`));
    assert.ok(!html.includes("image/svg+xml"), "sem link de SVG");
    assert.doesNotMatch(html, /rel="[^"]*icon"[^>]*\.webp/);
  });

  test("SVG: acrescenta o link e serve sem executar script; depois PNG tira o SVG", { timeout: 180_000 }, async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#c33"/></svg>');
    assert.equal((await send("/admin/api/favicon", "image/svg+xml", svg)).statusCode, 200);
    await ctx.builds.drain();
    const v = /\/favicon\.ico\?v=([0-9a-f]{10})/.exec(page())?.[1];
    assert.ok(page().includes(`<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg?v=${v}">`));
    const served = await ctx.app.inject({ url: "/assets/favicon.svg" });
    assert.equal(served.statusCode, 200);
    assert.match(String(served.headers["content-type"]), /image\/svg\+xml/);
    assert.match(String(served.headers["content-security-policy"]), /sandbox/);

    assert.equal((await send("/admin/api/favicon", "image/png", await image(64, 64).png().toBuffer())).statusCode, 200);
    await ctx.builds.drain();
    const v2 = /\/favicon\.ico\?v=([0-9a-f]{10})/.exec(page())?.[1];
    assert.notEqual(v2, v, "arquivo novo, versão nova");
    assert.ok(!page().includes("favicon.svg"));
    assert.ok(!existsSync(path.join(process.env.ASSETS_DIR!, "favicon.svg")));
  });

  test("imagem ilegível não troca os ícones atuais", async () => {
    const before = readFileSync(path.join(process.env.ASSETS_DIR!, "favicon.ico"));
    assert.equal((await send("/admin/api/favicon", "image/png", Buffer.from("não é imagem"))).statusCode, 415);
    assert.deepEqual(readFileSync(path.join(process.env.ASSETS_DIR!, "favicon.ico")), before);
  });
});
