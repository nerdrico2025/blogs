import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import sharp from "sharp";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-originais-"));
process.env.SITE = "exemplo";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
process.env.ADMIN_USER = "chefe";
const { hashPassword } = await import("./auth.ts");
const ADMIN_HASH = hashPassword("senha ficticia");
process.env.ADMIN_PASSWORD_HASH = ADMIN_HASH;
const { IMAGE_GENERATOR_VERSION, cleanOriginal, missingOriginals, syncBrandImages } = await import("./brand-images.ts");
const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const assets = process.env.ASSETS_DIR;
const originals = path.join(assets, "originais");
let ctx: Ctx;
let cookie = "";
const send = (url: string, type: string, payload: Buffer) => ctx.app.inject({ method: "POST", url, headers: { cookie, "content-type": type }, payload });
const png = (w = 600, h = 600) => sharp({ create: { width: w, height: h, channels: 4, background: "#c33" } }).png().toBuffer();
const brand = () => ctx.settings.current.brand!;

/** Registra pedidos de build e logs; JSON de tudo o que foi logado fica em `lines`. */
function deps() {
  const builds: string[] = [];
  const lines: string[] = [];
  const write = (...args: unknown[]) => void lines.push(JSON.stringify(args));
  return { builds, lines, value: { assetsDir: assets, settingsFile: process.env.SETTINGS_FILE!, settings: ctx.settings, builds: { request: (r: string) => void builds.push(r) }, log: { info: write, warn: write } as never } };
}

before(async () => {
  ctx = await buildApp(loadEnv({ user: "wordbee", passwordHash: hashPassword("outra"), contentDir: path.join(tmp, "p"), uploadsDir: path.join(tmp, "u"), stateFile: path.join(tmp, "s.json"), secretsFile: path.join(tmp, "x.json"), releasesDir: path.join(tmp, "r"), currentLink: path.join(tmp, "current"), buildMode: "none", serveStatic: true, scheduler: false }), { logger: false });
  const login = await ctx.app.inject({ method: "POST", url: "/admin/api/login", payload: { user: "chefe", password: "senha ficticia" } });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});
after(async () => {
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("original guardado no envio", () => {
  test("sem metadados, e com a rotação do EXIF já aplicada", async () => {
    const photo = await sharp({ create: { width: 300, height: 100, channels: 3, background: "#123" } }).withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "dado-pessoal" }, IFD3: { GPSLatitudeRef: "S" } } }).jpeg().toBuffer();
    const fixture = await sharp(photo).metadata();
    assert.ok(fixture.exif && fixture.orientation === 6, "a imagem de teste tem EXIF e rotação");
    assert.equal((await send("/admin/api/logo", "image/jpeg", photo)).statusCode, 200);
    const saved = readFileSync(path.join(originals, "logo.png"));
    const meta = await sharp(saved).metadata();
    assert.equal(meta.exif, undefined);
    assert.ok(!saved.includes("dado-pessoal"));
    assert.deepEqual([meta.width, meta.height], [100, 300], "a rotação não se perde");
  });

  test("SVG sem blocos e atributos de editor, ainda válido", async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:export-filename="/Users/fulano/segredo.png" viewBox="0 0 10 10"><!-- /Users/fulano --><metadata><rdf>autor</rdf></metadata><circle r="5"/></svg>`);
    const { data, ext } = await cleanOriginal(svg);
    assert.equal(ext, "svg");
    for (const piece of ["fulano", "segredo", "metadata", "inkscape"]) assert.ok(!data.includes(piece), piece);
    assert.equal((await sharp(data).metadata()).format, "svg");
  });

  test("trocar PNG por SVG não deixa o original antigo", async () => {
    assert.equal((await send("/admin/api/favicon", "image/png", await png())).statusCode, 200);
    assert.ok(existsSync(path.join(originals, "favicon.png")));
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16"/></svg>');
    assert.equal((await send("/admin/api/favicon", "image/svg+xml", svg)).statusCode, 200);
    assert.ok(existsSync(path.join(originals, "favicon.svg")));
    assert.ok(!existsSync(path.join(originals, "favicon.png")));
  });

  test("imagem ilegível não troca o original", async () => {
    const before = readFileSync(path.join(originals, "favicon.svg"));
    assert.equal((await send("/admin/api/favicon", "image/png", Buffer.from("não é imagem"))).statusCode, 415);
    assert.deepEqual(readFileSync(path.join(originals, "favicon.svg")), before);
  });

  test("os originais nunca são servidos", async () => {
    assert.ok(existsSync(path.join(originals, "logo.png")));
    for (const url of ["/assets/originais/logo.png", "/assets/originais/", "/assets/originais", "/assets//originais/logo.png", "/assets/./originais/logo.png", "/assets/x/../originais/logo.png", "/assets/%6Friginais/logo.png", "/assets/originais%2Flogo.png", "/assets/ORIGINAIS/logo.png", "/originais/logo.png", "/favicon.ico/../assets/originais/logo.png"]) {
      const res = await ctx.app.inject({ url });
      assert.notEqual(res.statusCode, 200, url);
      assert.ok(!res.rawPayload.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${url} entregou a imagem`);
    }
    const derived = await ctx.app.inject({ url: brand().logo!.src });
    assert.equal(derived.statusCode, 200, "as derivadas continuam públicas");
  });
});

describe("regeneração no arranque", () => {
  beforeEach(async () => {
    assert.equal((await send("/admin/api/favicon", "image/png", await png())).statusCode, 200);
    assert.equal((await send("/admin/api/logo", "image/png", await png(800, 200))).statusCode, 200);
    assert.equal((await send("/admin/api/logo-dark", "image/png", await png(800, 200))).statusCode, 200);
  });

  test("versão igual: não faz nada", async () => {
    await ctx.settings.update((s) => ({ ...s, imageGenerator: IMAGE_GENERATOR_VERSION }));
    const d = deps();
    assert.deepEqual(await syncBrandImages(d.value), []);
    assert.deepEqual(d.builds, []);
  });

  test("versão diferente: refaz tudo a partir do original, grava a versão e pede o rebuild", async () => {
    const generator = IMAGE_GENERATOR_VERSION + 100;
    const before = { favicon: brand().favicon, logo: brand().logo!.src, logoDark: brand().logoDark!.src };
    for (const f of ["favicon.ico", "favicon-32.png", "favicon-192.png", "favicon-512.png", "apple-touch-icon.png"]) await rm(path.join(assets, f));
    const d = deps();
    assert.deepEqual((await syncBrandImages(d.value, generator)).sort(), ["favicon", "logo", "logoDark"]);
    for (const f of ["favicon.ico", "favicon-32.png", "favicon-192.png", "favicon-512.png", "apple-touch-icon.png"]) assert.ok(existsSync(path.join(assets, f)), f);
    assert.deepEqual((await sharp(path.join(assets, "favicon-512.png")).metadata()).width, 512);
    assert.notEqual(brand().favicon, before.favicon, "?v= novo");
    assert.notEqual(brand().logo!.src, before.logo, "endereço novo");
    assert.notEqual(brand().logoDark!.src, before.logoDark);
    assert.ok(existsSync(path.join(assets, path.basename(brand().logo!.src))));
    assert.equal(JSON.parse(readFileSync(process.env.SETTINGS_FILE!, "utf8")).imageGenerator, generator);
    assert.equal(d.builds.length, 1, "um rebuild");
    assert.deepEqual(await syncBrandImages(d.value, generator), [], "o próximo arranque não repete");
    assert.equal(d.builds.length, 1);
    await ctx.settings.update((s) => ({ ...s, imageGenerator: IMAGE_GENERATOR_VERSION }));
  });

  test("original ilegível: os outros seguem, a versão não muda, e o log não traz caminhos nem segredos", async () => {
    await ctx.settings.update((s) => ({ ...s, imageGenerator: IMAGE_GENERATOR_VERSION }));
    await writeFile(path.join(originals, "logo.png"), "corrompido");
    const d = deps();
    const generator = IMAGE_GENERATOR_VERSION + 200;
    assert.deepEqual((await syncBrandImages(d.value, generator)).sort(), ["favicon", "logoDark"]);
    assert.equal(ctx.settings.current.imageGenerator, IMAGE_GENERATOR_VERSION, "o próximo arranque tenta de novo");
    const log = d.lines.join("\n");
    assert.match(log, /"kind":"logo"/);
    for (const secret of [tmp, "/originais", "/assets", ".png", ADMIN_HASH, "senha ficticia", process.env.SETTINGS_FILE!]) assert.ok(!log.includes(secret), `log contém ${secret}`);
  });
});

describe("imagens enviadas antes de guardar os originais", () => {
  test("sem original: não regenera, mantém a imagem e o painel pede o reenvio", async () => {
    assert.equal((await send("/admin/api/favicon", "image/png", await png())).statusCode, 200);
    assert.equal((await send("/admin/api/logo", "image/png", await png(800, 200))).statusCode, 200);
    await rm(originals, { recursive: true, force: true });
    await ctx.settings.update((s) => {
      const { logoDark: _drop, ...rest } = s.brand!;
      return { ...s, brand: rest, imageGenerator: undefined };
    });
    const src = brand().logo!.src;
    const d = deps();
    assert.deepEqual(await syncBrandImages(d.value), []);
    assert.deepEqual(d.builds, [], "sem rebuild à toa");
    assert.equal(brand().logo!.src, src);
    assert.equal(ctx.settings.current.imageGenerator, IMAGE_GENERATOR_VERSION);

    const state = (await ctx.app.inject({ url: "/admin/api/state", headers: { cookie } })).json();
    assert.deepEqual(state.missingOriginals, ["logo", "favicon"]);
    const page = (await ctx.app.inject({ url: "/admin/" })).body;
    assert.ok(page.includes("Reenvie o favicon para gerar todos os formatos"));
    assert.ok(page.includes('id="b-favicon-reupload-btn"'));

    assert.equal((await send("/admin/api/favicon", "image/png", await png())).statusCode, 200);
    const after = (await ctx.app.inject({ url: "/admin/api/state", headers: { cookie } })).json();
    assert.deepEqual(after.missingOriginals, ["logo"], "o reenvio resolve");
    for (const leak of [tmp, "originais"]) assert.ok(!JSON.stringify(after).includes(leak), "o estado não expõe caminhos");
  });

  test("identidade do assistente e blog sem envio não pedem reenvio", () => {
    assert.deepEqual(missingOriginals(assets, { logo: { src: "/assets/brand/logo.svg", width: 1, height: 1 }, favicon: "/assets/brand/favicon.svg" }), []);
    assert.deepEqual(missingOriginals(assets, undefined), []);
  });

  test("blog novo, sem settings.json: o arranque não cria o arquivo", async () => {
    const file = path.join(tmp, "novo", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    const updates: unknown[] = [];
    const empty = { current: {}, update: async (fn: (s: object) => object) => (updates.push(fn({})), {}) };
    await syncBrandImages({ assetsDir: path.join(tmp, "novo"), settingsFile: file, settings: empty as never, builds: { request() {} }, log: { info() {}, warn() {} } as never });
    assert.deepEqual(updates, []);
    assert.deepEqual(readdirSync(path.dirname(file)), []);
  });
});
