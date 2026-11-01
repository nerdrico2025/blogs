/** Aba Autor, ponta a ponta: salva pela rota do painel, roda o build real e lê o site publicado. */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-author-"));
process.env.SITE = "asasdomundo";
process.env.SITE_URL = "https://blog.example";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
process.env.ADMIN_USER = "chefe";
const { hashPassword } = await import("./auth.ts");
process.env.ADMIN_PASSWORD_HASH = hashPassword("senha ficticia");
const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");

const current = path.join(tmp, "current");
const content = path.join(tmp, "posts");
let ctx: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";
const wp = { authorization: "Basic " + Buffer.from("wordbee:outra").toString("base64"), "content-type": "application/json" };
const read = (f: string) => readFileSync(path.join(current, f), "utf8");
const saveAuthor = (payload: object, headers: Record<string, string> = {}) => ctx.app.inject({ method: "POST", url: "/admin/api/author", headers: { cookie, ...headers }, payload });
const ldGraph = (html: string) => JSON.parse(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!)["@graph"] as Record<string, unknown>[];

const AUTHOR = {
  name: "Ana Souza",
  role: "Consultora de viagens",
  bioShort: "Viaja há 20 anos & orienta <b>famílias</b>.",
  bioFull: "Primeiro parágrafo.\n\nSegundo <script>alert(1)</script> parágrafo.",
  photoAlt: "Retrato de Ana",
  credentials: ["Guia credenciada", "Vinte anos de estrada"],
  specialties: ["Europa", "Viagem em família"],
  links: { site: "https://ana.example/", instagram: "https://instagram.com/ana", linkedin: "", youtube: "", x: "" },
  email: "ana@ana.example",
};

before(async () => {
  ctx = await buildApp(
    loadEnv({
      user: "wordbee",
      passwordHash: hashPassword("outra"),
      contentDir: content,
      uploadsDir: path.join(tmp, "uploads"),
      stateFile: path.join(tmp, "state.json"),
      secretsFile: path.join(tmp, "secrets.json"),
      trashDir: path.join(tmp, "lixeira"),
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

describe("regras", () => {
  for (const [name, payload, message] of [
    ["javascript: no link", { links: { site: "javascript:alert(1)" } }, /endereço completo/],
    ["JAVASCRIPT: com maiúsculas", { links: { x: "JAVASCRIPT:alert(1)" } }, /endereço completo/],
    ["link interno", { links: { youtube: "/sobre/" } }, /endereço completo/],
    ["bio curta longa", { bioShort: "x".repeat(201) }, /longo demais/],
    ["sete credenciais", { credentials: Array(7).fill("x") }, /máximo 6/],
    ["nove especialidades", { specialties: Array(9).fill("x") }, /máximo 8/],
    ["e-mail inválido", { email: "javascript:alert(1)" }, /E-mail/],
  ] as const) {
    test(`recusa ${name}`, async () => {
      const res = await saveAuthor({ name: "X", ...payload });
      assert.equal(res.statusCode, 400, res.body);
      assert.match(res.json().message, message);
    });
  }
  test("sem login: 401; de outra origem: 403", async () => {
    assert.equal((await ctx.app.inject({ method: "POST", url: "/admin/api/author", payload: AUTHOR })).statusCode, 401);
    assert.equal((await ctx.app.inject({ method: "POST", url: "/admin/api/author-photo", headers: { "content-type": "image/png" }, payload: Buffer.from("x") })).statusCode, 401);
    assert.equal((await saveAuthor(AUTHOR, { origin: "https://mal.example" })).statusCode, 403);
    assert.ok(!existsSync(process.env.SETTINGS_FILE!));
  });
  test("SVG e arquivo inválido não viram foto", async () => {
    const send = (type: string, payload: Buffer) => ctx.app.inject({ method: "POST", url: "/admin/api/author-photo", headers: { cookie, "content-type": type }, payload });
    assert.equal((await send("image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>'))).statusCode, 415);
    assert.equal((await send("image/png", Buffer.from("nao e imagem"))).statusCode, 415);
  });
});

describe("no site publicado", () => {
  let slug = "";

  test("sem autor: assinatura da equipe, sem página, e o `author` do POST não entra", { timeout: 180_000 }, async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: wp, payload: { title: "Roteiro assinado", content: "<p>Texto do roteiro.</p>", status: "publish", author: 99 } });
    assert.equal(res.statusCode, 201, res.body);
    slug = res.json().slug;
    assert.doesNotMatch(readFileSync(path.join(content, `${slug}.md`), "utf8"), /^author:/m);
    assert.ok(!("author" in res.json()), "resposta igual à de sempre");
    await ctx.builds.drain();
    assert.equal(ctx.builds.getStatus().lastBuild?.ok, true, ctx.builds.getStatus().lastBuild?.error);
    assert.match(read(`${slug}/index.html`), /Por Equipe Asas do Mundo/);
    assert.ok(!existsSync(path.join(current, "autor")));
    assert.doesNotMatch(read("sitemap.xml"), /\/autor\//);
    assert.doesNotMatch(read("index.html"), /class="author-sign"/);
  });

  test("com autor: assinatura, página, caixa, dados estruturados, RSS e sitemap", { timeout: 180_000 }, async () => {
    const me = async () => (await ctx.app.inject({ url: "/wp-json/wp/v2/users/me", headers: wp })).json();
    const before = await me();

    const photo = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#369" } }).withMetadata({ exif: { IFD0: { Copyright: "GPS-SECRETO" } } }).jpeg().toBuffer();
    const up = await ctx.app.inject({ method: "POST", url: "/admin/api/author-photo", headers: { cookie, "content-type": "image/jpeg" }, payload: photo });
    assert.equal(up.statusCode, 200, up.body);
    assert.equal((await saveAuthor(AUTHOR)).statusCode, 200);

    // Post gravado à mão com outro autor: a assinatura continua sendo a cadastrada
    await writeFile(path.join(content, "manual.md"), "---\ntitle: Post manual\ndate: 2020-01-02\ncategory: dicas\nauthor: autor\n---\n\nTexto\n");
    await ctx.builds.drain();
    assert.equal(ctx.builds.getStatus().lastBuild?.ok, true, ctx.builds.getStatus().lastBuild?.error);

    assert.deepEqual(await me(), before, "GET /users/me não muda");

    const saved = JSON.parse(readFileSync(process.env.SETTINGS_FILE!, "utf8")).authorProfile;
    assert.equal(saved.slug, "ana-souza");
    const base = saved.photo.base.replace("/assets/", "");
    for (const w of [96, 192, 400]) {
      const meta = await sharp(path.join(tmp, "assets", `${base}-${w}.webp`)).metadata();
      assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ["webp", w, w, undefined]);
    }
    assert.equal((await sharp(path.join(tmp, "assets", "originais", "autor.png")).metadata()).exif, undefined);
    assert.ok(!readFileSync(path.join(tmp, "assets", "originais", "autor.png")).includes("GPS-SECRETO"));
    assert.notEqual((await ctx.app.inject({ url: "/assets/originais/autor.png" })).statusCode, 200);

    const article = read(`${slug}/index.html`);
    assert.doesNotMatch(article, /Equipe Asas do Mundo/);
    assert.match(article, /class="author-sign-name" href="\/autor\/ana-souza\/"[^>]*>Ana Souza/);
    assert.match(article, /Consultora de viagens/);
    assert.match(article, new RegExp(`${base}-96\\.webp`));
    assert.match(article, /Sobre o autor/);
    assert.match(article, /Viaja há 20 anos &amp; orienta &(lt|#x3C|#60);b/);
    assert.doesNotMatch(article, /<b>famílias/);
    assert.match(read("index.html"), /author-sign-name/);
    assert.match(read("manual/index.html"), /Ana Souza/);

    const person = ldGraph(article).find((n) => n["@type"] === "Person")!;
    assert.equal(person.name, "Ana Souza");
    assert.equal(person.jobTitle, "Consultora de viagens");
    assert.equal(person.url, "https://blog.example/autor/ana-souza/");
    assert.equal(person.image, `https://blog.example${saved.photo.base}-400.webp`);
    assert.deepEqual(person.sameAs, ["https://ana.example/", "https://instagram.com/ana"]);
    const posting = ldGraph(article).find((n) => n["@type"] === "BlogPosting")!;
    assert.deepEqual(posting.author, { "@id": person["@id"] });

    const page = read("autor/ana-souza/index.html");
    assert.match(page, /<h1>Ana Souza/);
    assert.match(page, /Primeiro parágrafo/);
    assert.match(page, /Guia credenciada/);
    assert.match(page, /Viagem em família/);
    assert.match(page, /Roteiro assinado/);
    assert.match(page, /Post manual/);
    assert.match(page, /href="https:\/\/ana\.example\/" rel="me noopener"/);
    assert.match(page, /mailto:ana@ana\.example/);
    assert.match(page, /alt="Retrato de Ana"/);
    assert.doesNotMatch(page, /<script>alert/);
    const graph = ldGraph(page);
    assert.ok(graph.some((n) => n["@type"] === "ProfilePage"));
    assert.equal(graph.find((n) => n["@type"] === "Person")!.name, "Ana Souza");

    assert.match(read("feed.xml"), /<dc:creator>Ana Souza<\/dc:creator>/);
    assert.match(read("sitemap.xml"), /<loc>https:\/\/blog\.example\/autor\/ana-souza\/<\/loc>/);
  });

  test("trocar o nome: endereço novo, e o antigo redireciona", { timeout: 180_000 }, async () => {
    assert.equal((await saveAuthor({ ...AUTHOR, name: "Ana Lima" })).statusCode, 200);
    await ctx.builds.drain();
    assert.ok(existsSync(path.join(current, "autor", "ana-lima", "index.html")));
    assert.ok(!existsSync(path.join(current, "autor", "ana-souza")));
    const old = await ctx.app.inject({ url: "/autor/ana-souza/" });
    assert.equal(old.statusCode, 301);
    assert.equal(old.headers.location, "/autor/ana-lima/");
  });

  test("apagar o nome: volta a assinatura da equipe, sem página; a foto pode ser removida", { timeout: 180_000 }, async () => {
    const res = await saveAuthor({ ...AUTHOR, name: "", removePhoto: true });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().author.photo, undefined);
    await ctx.builds.drain();
    assert.ok(!readdirSync(path.join(tmp, "assets")).some((f) => f.startsWith("autor-")));
    assert.ok(!existsSync(path.join(tmp, "assets", "originais", "autor.png")));
    assert.match(read(`${slug}/index.html`), /Por Equipe Asas do Mundo/);
    assert.ok(!existsSync(path.join(current, "autor")));
    assert.equal((await ctx.app.inject({ url: "/autor/ana-lima/" })).statusCode, 404);
    assert.equal((await ctx.app.inject({ url: "/autor/ana-souza/" })).statusCode, 404, "sem autor, sem redirecionamento");
  });
});

test("foto: uma versão nova do gerador refaz as imagens a partir do original", async () => {
  const { syncBrandImages } = await import("./brand-images.ts");
  const assets = path.join(tmp, "assets-sync");
  mkdirSync(path.join(assets, "originais"), { recursive: true });
  await sharp({ create: { width: 500, height: 500, channels: 3, background: "#963" } }).png().toFile(path.join(assets, "originais", "autor.png"));
  const reasons: string[] = [];
  const settings = { current: { authorProfile: { photo: { base: "/assets/autor-0000000000" } } } as never, update: async (fn: (s: never) => never) => (settings.current = fn(settings.current)) };
  await syncBrandImages({ assetsDir: assets, settingsFile: path.join(tmp, "x.json"), settings: settings as never, builds: { request: (r) => reasons.push(r) }, log: { info() {}, warn() {} } as never }, 99);
  const base = (settings.current as { authorProfile: { photo: { base: string } } }).authorProfile.photo.base;
  assert.notEqual(base, "/assets/autor-0000000000");
  assert.ok(existsSync(path.join(assets, `${base.replace("/assets/", "")}-400.webp`)));
  assert.equal(reasons.length, 1);
});
