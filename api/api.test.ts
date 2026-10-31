import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import site from "../site.config.ts";
import { hashPassword, verifyPassword } from "./auth.ts";
import { srcset } from "../shared/media.ts";
import { loadEnv } from "./env.ts";
import { buildApp, type App } from "./server.ts";

const USER = "wordbee";
const PASSWORD = "abcd EFGH ijkl MNOP qrst UVWX";
const basic = (u: string, p: string) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
const AUTH = { authorization: basic(USER, PASSWORD) };

let tmp: string;
let ctx: App;

async function png(width = 800, height = 450): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#3366cc" } }).png().toBuffer();
}

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "blog-api-"));
  const env = loadEnv({
    user: USER,
    passwordHash: hashPassword(PASSWORD),
    contentDir: path.join(tmp, "posts"),
    uploadsDir: path.join(tmp, "uploads"),
    stateFile: path.join(tmp, "state.json"),
    buildMode: "none",
    maxUploadBytes: 2 * 1024 * 1024,
  });
  ctx = await buildApp(env, { logger: false });
});

after(async () => {
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("autenticação", () => {
  test("sem credencial: 401 no formato do WP", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/wp-json/wp/v2/users/me?context=edit" });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(Object.keys(res.json()).sort(), ["code", "data", "message"]);
    assert.equal(res.json().data.status, 401);
  });

  test("senha errada: 401", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/wp-json/wp/v2/users/me", headers: { authorization: basic(USER, "errada") } });
    assert.equal(res.statusCode, 401);
  });

  test("usuário errado: 401", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/wp-json/wp/v2/users/me", headers: { authorization: basic("outro", PASSWORD) } });
    assert.equal(res.statusCode, 401);
  });

  test("teste de conexão do Wordbee: id inteiro e papel administrator", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/wp-json/wp/v2/users/me?context=edit", headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.ok(Number.isInteger(res.json().id));
    assert.ok(res.json().roles.includes("administrator"));
  });

  test("hash sem \"$\" (seguro em variável de ambiente) e formato antigo com \"$\" ainda aceito", async () => {
    const h = hashPassword("x y");
    assert.ok(!h.includes("$"));
    assert.ok(verifyPassword("xy", h));
    assert.ok(verifyPassword("x y", h.replaceAll(":", "$")));
    assert.ok(!verifyPassword("errada", h));
  });

  test("senha de aplicação sem os espaços também vale (como no WP)", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/wp-json/wp/v2/users/me", headers: { authorization: basic(USER, PASSWORD.replace(/ /g, "")) } });
    assert.equal(res.statusCode, 200);
  });

  test("bloqueia o IP depois de 10 falhas (429)", async () => {
    const ip = "203.0.113.9";
    for (let i = 0; i < 10; i++) {
      const r = await ctx.app.inject({ method: "GET", url: "/wp-json/wp/v2/users/me", remoteAddress: ip, headers: { authorization: basic(USER, "x") } });
      assert.equal(r.statusCode, 401);
    }
    const res = await ctx.app.inject({ method: "GET", url: "/wp-json/wp/v2/users/me", remoteAddress: ip, headers: AUTH });
    assert.equal(res.statusCode, 429);
  });
});

describe("categorias", () => {
  test("lista as categorias do site.config.ts com ids estáveis", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/wp-json/wp/v2/categories?per_page=100&orderby=name&order=asc", headers: AUTH });
    assert.equal(res.statusCode, 200);
    const list = res.json() as { id: number; name: string; slug: string }[];
    assert.equal(list.length, site.categories.length);
    for (const c of site.categories) assert.ok(list.some((x) => x.id === c.id && x.slug === c.slug && x.name === c.name));
    const names = list.map((c) => c.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "pt-BR")));
  });
});

let mediaId: number;

describe("mídia", () => {
  test("upload binário: 201, id inteiro e versão otimizada disponível na hora", async () => {
    const data = await png(2000, 1000);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/wp-json/wp/v2/media",
      headers: { ...AUTH, "content-type": "image/png", "content-disposition": 'attachment; filename="Lisboa Ótima.png"' },
      payload: data,
    });
    assert.equal(res.statusCode, 201, res.body);
    const json = res.json();
    assert.ok(Number.isInteger(json.id));
    mediaId = json.id;
    assert.match(json.source_url, new RegExp(`^${site.url}/wp-content/uploads/\\d{4}/\\d{2}/lisboa-otima\\.jpg$`));
    assert.equal(json.mime_type, "image/jpeg");
    assert.equal(json.media_details.width, 1600);
    assert.equal(json.media_details.height, 800);
    const file = path.join(tmp, "uploads", json.source_url.replace(`${site.url}/wp-content/uploads/`, ""));
    const jpeg = await sharp(file).metadata();
    assert.equal(jpeg.format, "jpeg");
    assert.equal(jpeg.width, 1600);
    assert.equal(jpeg.isProgressive, true);
    assert.equal(jpeg.exif, undefined);
    const webp = await sharp(file.replace(/\.jpg$/, ".webp")).metadata();
    assert.equal(webp.format, "webp");
    assert.equal(webp.width, 1600);
    for (const w of [160, 480, 800, 1200]) {
      assert.equal((await sharp(file.replace(/\.jpg$/, `-${w}.webp`)).metadata()).width, w);
    }
    const og = await sharp(file.replace(/\.jpg$/, "-og.jpg")).metadata();
    assert.equal(og.format, "jpeg");
    assert.equal(og.width, 1200);
    assert.ok(!existsSync(file.replace(/\.jpg$/, ".png")), "o arquivo enviado não é guardado");
  });

  test("respeita a rotação, remove metadados e não amplia imagem pequena", async () => {
    const data = await sharp({ create: { width: 600, height: 300, channels: 3, background: "#cc3366" } })
      .withExif({ IFD0: { Copyright: "dado-sensivel" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    assert.ok((await sharp(data).metadata()).exif, "a entrada do teste precisa ter EXIF");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/wp-json/wp/v2/media",
      headers: { ...AUTH, "content-type": "image/jpeg", "content-disposition": 'attachment; filename="girada.jpg"' },
      payload: data,
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().media_details.width, 300);
    assert.equal(res.json().media_details.height, 600);
    const file = path.join(tmp, "uploads", res.json().source_url.replace(`${site.url}/wp-content/uploads/`, ""));
    const main = await sharp(file).metadata();
    assert.equal(main.width, 300);
    assert.equal(main.exif, undefined);
    assert.equal(main.orientation, undefined);
    assert.ok(existsSync(file.replace(/\.jpg$/, "-160.webp")));
    assert.ok(!existsSync(file.replace(/\.jpg$/, "-480.webp")), "sem variante maior que a imagem");
  });

  test("PNG transparente vira JPEG com fundo branco", async () => {
    const data = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/media", headers: { ...AUTH, "content-type": "image/png", "content-disposition": 'attachment; filename="transparente.png"' }, payload: data });
    assert.equal(res.statusCode, 201, res.body);
    const file = path.join(tmp, "uploads", res.json().source_url.replace(`${site.url}/wp-content/uploads/`, ""));
    const { dominant } = await sharp(file).stats();
    assert.ok(dominant.r > 240 && dominant.g > 240 && dominant.b > 240);
  });

  test("resolução acima do limite: 415", async () => {
    const data = await sharp({ create: { width: 8000, height: 7000, channels: 3, background: "#000" } }).png({ compressionLevel: 1 }).toBuffer();
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/media", headers: { ...AUTH, "content-type": "image/png" }, payload: data });
    assert.equal(res.statusCode, 415);
  });

  test("srcset usa o arquivo principal na maior largura; imagem antiga mantém as variantes", () => {
    const novo = { src: "/wp-content/uploads/a.webp", width: 1600, height: 800, widths: [480, 1600], formats: ["webp"] as ("avif" | "webp")[], og: "" };
    assert.equal(srcset(novo, "webp"), "/wp-content/uploads/a-480.webp 480w, /wp-content/uploads/a.webp 1600w");
    const antigo = { ...novo, src: "/wp-content/uploads/a.png", formats: ["avif", "webp"] as ("avif" | "webp")[] };
    assert.equal(srcset(antigo, "avif"), "/wp-content/uploads/a-480.avif 480w, /wp-content/uploads/a-1600.avif 1600w");
  });

  test("mesmo nome de arquivo não sobrescreve (sufixo -2)", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/wp-json/wp/v2/media",
      headers: { ...AUTH, "content-type": "image/png", "content-disposition": 'attachment; filename="lisboa-otima.png"' },
      payload: await png(),
    });
    assert.equal(res.statusCode, 201);
    assert.match(res.json().source_url, /lisboa-otima-2\.jpg$/);
  });

  test("tipo não suportado: 415", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/media", headers: { ...AUTH, "content-type": "image/svg+xml" }, payload: "<svg/>" });
    assert.equal(res.statusCode, 415);
  });

  test("bytes que não são imagem: 415", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/media", headers: { ...AUTH, "content-type": "image/png" }, payload: Buffer.from("isto não é png") });
    assert.equal(res.statusCode, 415);
  });

  test("acima do limite: 413", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/media", headers: { ...AUTH, "content-type": "image/png" }, payload: Buffer.alloc(3 * 1024 * 1024) });
    assert.equal(res.statusCode, 413);
  });

  test("sem autenticação: 401", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/media", headers: { "content-type": "image/png" }, payload: await png() });
    assert.equal(res.statusCode, 401);
  });
});

const CONTENT = `<p>Introdução do artigo.</p><script>alert(1)</script><h2>Primeira parte</h2><p onclick="x()">Texto com <strong>negrito</strong>.</p><blockquote><p>Uma dica.</p></blockquote>`;

function postBody(extra: Record<string, unknown> = {}) {
  return {
    title: "Roteiro de teste: 3 dias",
    content: CONTENT,
    status: "publish",
    excerpt: "Resumo gerado pela IA para o card e a meta description.",
    slug: "roteiro-de-teste",
    categories: [site.categories[0]!.id],
    featured_media: mediaId,
    ...extra,
  };
}

describe("posts", () => {
  let first: { id: number; link: string };

  test("cria: 201 com id inteiro e link público final", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: postBody() });
    assert.equal(res.statusCode, 201, res.body);
    first = res.json();
    assert.ok(Number.isInteger(first.id));
    assert.equal(first.link, `${site.url}/roteiro-de-teste/`);
  });

  test("grava Markdown sanitizado com frontmatter completo", () => {
    const md = readFileSync(path.join(tmp, "posts", "roteiro-de-teste.md"), "utf8");
    assert.doesNotMatch(md, /<script|alert|onclick/);
    assert.match(md, /## Primeira parte/);
    assert.match(md, /\*\*negrito\*\*/);
    assert.match(md, /^> Uma dica\./m);
    assert.match(md, /^status: publish$/m);
    assert.match(md, new RegExp(`^category: ${site.categories[0]!.slug}$`, "m"));
    assert.match(md, /alt: "Roteiro de teste: 3 dias"/);
    assert.match(md, /^description: Resumo gerado pela IA/m);
    assert.match(md, new RegExp(`^wpId: ${first.id}$`, "m"));
  });

  test("POST repetido (retry após timeout) devolve o mesmo post", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: postBody() });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().id, first.id);
    assert.equal(res.json().link, first.link);
    assert.ok(!existsSync(path.join(tmp, "posts", "roteiro-de-teste-2.md")));
  });

  test("mesmo slug com conteúdo diferente cria slug-2; o retry dele também é idempotente", async () => {
    const body = postBody({ content: "<p>Outro texto.</p>" });
    const a = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: body });
    assert.equal(a.statusCode, 201);
    assert.equal(a.json().slug, "roteiro-de-teste-2");
    assert.notEqual(a.json().id, first.id);
    const b = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: body });
    assert.equal(b.statusCode, 200);
    assert.equal(b.json().id, a.json().id);
  });

  test("slug reservado ou de página fixa ganha sufixo", async () => {
    const a = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: postBody({ slug: "search", content: "<p>a</p>" }) });
    assert.equal(a.json().slug, "search-2");
    const b = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: postBody({ slug: "sobre", content: "<p>b</p>" }) });
    assert.equal(b.json().slug, "sobre-2");
  });

  test("sem slug: gerado do título, sem acentos", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: postBody({ slug: undefined, title: "Ação & Reação em São Paulo", content: "<p>c</p>" }) });
    assert.equal(res.json().slug, "acao-reacao-em-sao-paulo");
  });

  test("rascunho fica com status draft", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: postBody({ slug: "rascunho", status: "draft", content: "<p>d</p>" }) });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().status, "draft");
    assert.match(readFileSync(path.join(tmp, "posts", "rascunho.md"), "utf8"), /^status: draft$/m);
  });

  test("categoria inexistente: 400", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: postBody({ categories: [9999], content: "<p>e</p>" }) });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, "rest_invalid_param");
  });

  test("mídia inexistente: 400", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: postBody({ featured_media: 99999, content: "<p>f</p>" }) });
    assert.equal(res.statusCode, 400);
  });

  test("status future: 400 (fora da v1)", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: postBody({ status: "future", content: "<p>g</p>" }) });
    assert.equal(res.statusCode, 400);
  });

  test("sem autenticação: 401", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", payload: postBody() });
    assert.equal(res.statusCode, 401);
  });

  test("ids continuam crescendo depois de reiniciar a API", async () => {
    const env2 = loadEnv({
      user: USER,
      passwordHash: hashPassword(PASSWORD),
      contentDir: path.join(tmp, "posts"),
      uploadsDir: path.join(tmp, "uploads"),
      stateFile: path.join(tmp, "state.json"),
      buildMode: "none",
    });
    const ctx2 = await buildApp(env2, { logger: false });
    const res = await ctx2.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: postBody({ slug: "depois-do-restart", content: "<p>h</p>" }) });
    assert.ok(res.json().id > first.id);
    const replay = await ctx2.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: postBody() });
    assert.equal(replay.json().id, first.id, "o retry é reconhecido também depois do restart");
    await ctx2.app.close();
  });
});

describe("outros", () => {
  test("rota inexistente: 404 rest_no_route", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/wp-json/wp/v2/tags", headers: AUTH });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, "rest_no_route");
  });

  test("/internal/rebuild só aceita conexão local direta", async () => {
    const ok = await ctx.app.inject({ method: "POST", url: "/internal/rebuild", remoteAddress: "127.0.0.1" });
    assert.equal(ok.statusCode, 202);
    const proxied = await ctx.app.inject({ method: "POST", url: "/internal/rebuild", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.7" } });
    assert.equal(proxied.statusCode, 404);
    const remote = await ctx.app.inject({ method: "POST", url: "/internal/rebuild", remoteAddress: "198.51.100.7" });
    assert.equal(remote.statusCode, 404);
  });

  test("/health responde sem autenticação e sem segredos", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, "ok");
    assert.doesNotMatch(res.body, /scrypt|wordbee|password/i);
  });
});
