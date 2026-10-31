import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-admin-"));
process.env.SITE = "exemplo";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
process.env.ADMIN_USER = "chefe";

const { hashPassword } = await import("./auth.ts");
process.env.ADMIN_PASSWORD_HASH = hashPassword("senha do painel");
const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");
const { default: site } = await import("../site.config.ts");
const { insertInContent, activeSlot } = await import("../src/lib/ads.ts");
const { splitAt } = await import("../src/lib/article.ts");
const { contrastRatio, ensureReadable, contrastWarnings } = await import("../shared/settings.ts");
type Ctx = Awaited<ReturnType<typeof buildApp>>;

let ctx: Ctx;
let cookie = "";
const WP_AUTH = { authorization: "Basic " + Buffer.from("wordbee:senha velha").toString("base64") };
const post = (url: string, payload: object) => ctx.app.inject({ method: "POST", url, headers: { cookie }, payload });

before(async () => {
  const env = loadEnv({
    user: "wordbee",
    passwordHash: hashPassword("senha velha"),
    contentDir: path.join(tmp, "posts"),
    uploadsDir: path.join(tmp, "uploads"),
    stateFile: path.join(tmp, "state.json"),
    secretsFile: path.join(tmp, "secrets.json"),
    buildMode: "none",
    serveStatic: true,
    currentLink: path.join(tmp, "current"),
  });
  ctx = await buildApp(env, { logger: false });
  const res = await ctx.app.inject({ method: "POST", url: "/admin/api/login", payload: { user: "chefe", password: "senha do painel" } });
  assert.equal(res.statusCode, 200, res.body);
  const set = String(res.headers["set-cookie"]);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(";")[0]!;
});

after(async () => {
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("login do /admin", () => {
  test("sem sessão: 401; a página de login abre com noindex", async () => {
    const res = await ctx.app.inject({ url: "/admin/api/state" });
    assert.equal(res.statusCode, 401);
    const page = await ctx.app.inject({ url: "/admin/" });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers["x-robots-tag"]), /noindex/);
  });

  test("POST de outra origem é recusado", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/admin/api/tracking", headers: { cookie, origin: "https://outro.example", host: "blog.example" }, payload: {} });
    assert.equal(res.statusCode, 403);
  });

  test("bloqueia depois de 5 senhas erradas", async () => {
    const attempt = () => ctx.app.inject({ method: "POST", url: "/admin/api/login", remoteAddress: "10.9.9.9", payload: { user: "chefe", password: "errada" } });
    for (let i = 0; i < 5; i++) assert.equal((await attempt()).statusCode, 401);
    assert.equal((await attempt()).statusCode, 429);
  });
});

describe("configurações", () => {
  test("marca: grava de forma atômica, aplica e avisa sobre contraste ruim", async () => {
    const res = await post("/admin/api/brand", { name: "Novo Nome", colors: { primary: "#ffee00" } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(site.name, "Novo Nome");
    assert.equal(site.theme.colors.accent, "#ffee00");
    assert.ok(res.json().warnings.length > 0);
    const saved = JSON.parse(readFileSync(process.env.SETTINGS_FILE!, "utf8"));
    assert.equal(saved.brand.name, "Novo Nome");
    assert.equal(saved.brand.colors.highlight, undefined, "cor não mexida continua vindo do config");
    assert.equal((await post("/admin/api/brand", { colors: { primary: "azul" } })).statusCode, 400);
  });

  test("dicas de Marca e Rastreamento na página; limite de envio no estado", async () => {
    const page = (await ctx.app.inject({ url: "/admin/" })).body;
    for (const text of ["Use PNG com fundo transparente ou SVG, horizontal, em torno de 400 × 100 px (proporção 4:1), até 200 KB.", "Use PNG ou SVG quadrado, de 512 × 512 px, com figura simples e sem texto pequeno.", "Não cole o código do Tag Manager aqui, para não duplicar as medições."]) assert.ok(page.includes(text), text);
    const state = await ctx.app.inject({ url: "/admin/api/state", headers: { cookie } });
    assert.ok(state.json().maxUploadBytes > 0);
    for (const label of ["Cor principal", "Cor de destaque", "Cartão de chamada"]) assert.ok(page.includes(`aria-label="${label}: código hexadecimal"`), label);
    assert.ok(page.indexOf("/admin/ui/color.js") < page.indexOf("/admin/ui/admin.js"), "color.js carrega antes");
    assert.equal((await ctx.app.inject({ url: "/admin/ui/color.js" })).statusCode, 200);
  });

  test("logotipo e favicon: otimizados em /assets", async () => {
    const png = await sharp({ create: { width: 1000, height: 400, channels: 3, background: "#123456" } }).png().toBuffer();
    const res = await ctx.app.inject({ method: "POST", url: "/admin/api/logo", headers: { cookie, "content-type": "image/png" }, payload: png });
    assert.equal(res.statusCode, 200, res.body);
    const src = res.json().logo as string;
    assert.match(src, /^\/assets\/logo-[0-9a-f]+\.webp$/);
    assert.equal((await sharp(path.join(tmp, "assets", path.basename(src))).metadata()).height, 160);
    assert.equal(site.logo.height, 40);
    const served = await ctx.app.inject({ url: src });
    assert.equal(served.statusCode, 200);
    const fav = await ctx.app.inject({ method: "POST", url: "/admin/api/favicon", headers: { cookie, "content-type": "image/png" }, payload: png });
    assert.match(fav.json().favicon, /^\/assets\/favicon-192\.png\?v=[0-9a-f]{10}$/);
    const bad = await ctx.app.inject({ method: "POST", url: "/admin/api/logo", headers: { cookie, "content-type": "image/png" }, payload: Buffer.from("não é imagem") });
    assert.equal(bad.statusCode, 415);
  });

  test("rastreamento: valida o ID do GTM", async () => {
    assert.equal((await post("/admin/api/tracking", { gtmId: "UA-123" })).statusCode, 400);
    assert.equal((await post("/admin/api/tracking", { gtmId: "gtm-abc123", headCode: "<script>1</script>" })).json().tracking.gtmId, "GTM-ABC123");
  });

  test("categorias: renomeia sem mudar id, slug antigo vira alias e novo id é inédito", async () => {
    const original = site.categories.map((c) => ({ ...c }));
    const maxId = Math.max(...original.map((c) => c.id));
    const edited = original.map((c, i) => (i === 0 ? { ...c, name: "Renomeada", slug: "renomeada" } : c));
    const res = await post("/admin/api/categories", { categories: [...edited, { name: "Nova", slug: "nova", description: "x" }] });
    assert.equal(res.statusCode, 200, res.body);
    const cats = res.json().categories as { id: number; slug: string; aliases?: string[] }[];
    assert.equal(cats[0]!.id, original[0]!.id);
    assert.deepEqual(cats[0]!.aliases, [original[0]!.slug]);
    assert.equal(cats.at(-1)!.id, maxId + 1);

    // O Wordbee vê o novo nome com o mesmo id
    const wp = await ctx.app.inject({ url: "/wp-json/wp/v2/categories", headers: WP_AUTH });
    assert.ok(wp.json().some((c: { id: number; name: string }) => c.id === original[0]!.id && c.name === "Renomeada"));

    // URL antiga redireciona
    const old = await ctx.app.inject({ url: `/category/${original[0]!.slug}/page/2/` });
    assert.equal(old.statusCode, 301);
    assert.equal(old.headers.location, "/category/renomeada/page/2/");

    // Apagar ou tomar slug antigo é recusado
    assert.equal((await post("/admin/api/categories", { categories: cats.slice(1) })).statusCode, 400);
    const taken = cats.map((c, i) => (i === 1 ? { ...c, slug: original[0]!.slug } : c));
    assert.equal((await post("/admin/api/categories", { categories: taken })).statusCode, 400);
    assert.equal((await post("/admin/api/categories", { categories: cats.map((c, i) => (i === 0 ? { ...c, id: 9999 } : c)) })).statusCode, 400);
  });

  test("senha do Wordbee por variável não pode ser trocada no painel", async () => {
    assert.equal((await post("/admin/api/wordbee-password", {})).statusCode, 409);
    assert.equal((await ctx.app.inject({ url: "/wp-json/wp/v2/users/me", headers: WP_AUTH })).statusCode, 200);
    assert.ok(!existsSync(path.join(tmp, "secrets.json")) || statSync(path.join(tmp, "secrets.json")).isFile());
  });
});

describe("posições de anúncio", () => {
  const slot = (extra = {}) => ({ enabled: true, code: "<b>AD</b>", devices: "both" as const, pageTypes: ["article" as const], includeCategories: [], excludeCategories: [], minHeight: 250, ...extra });
  const count = (html: string) => (html.match(/class="ad-slot/g) ?? []).length;
  const P = (n: number) => `<p>${n}</p>`;

  test("conta só <p> de primeiro nível", () => {
    const html = `${P(1)}<blockquote><p>dentro</p><p>dentro</p></blockquote>${P(2)}${P(3)}`;
    const out = insertInContent(html, slot({ afterParagraph: 2 }));
    assert.ok(out.indexOf('class="ad-slot') > out.indexOf("<p>2</p>"));
    assert.ok(out.indexOf('class="ad-slot') < out.indexOf("<p>3</p>"));
  });

  test("repete a cada N com máximo de blocos", () => {
    const html = Array.from({ length: 12 }, (_, i) => P(i + 1)).join("");
    assert.equal(count(insertInContent(html, slot({ afterParagraph: 2, repeatEvery: 3, maxBlocks: 3 }))), 3);
    assert.equal(count(insertInContent(html, slot({ afterParagraph: 2 }))), 1);
    const out = insertInContent(html, slot({ afterParagraph: 2, repeatEvery: 3, maxBlocks: 2 }));
    const order = out.split('class="ad-slot');
    assert.ok(order[0]!.endsWith('<aside ') && order[0]!.includes("<p>2</p>") && !order[0]!.includes("<p>3</p>"));
    assert.ok(order[1]!.includes("<p>5</p>") && !order[1]!.includes("<p>6</p>"));
  });

  test("nunca colado em título, FAQ nem no fim do texto", () => {
    const out = insertInContent(`${P(1)}<h2>Título</h2>${P(2)}${P(3)}`, slot({ afterParagraph: 1 }));
    assert.ok(out.indexOf('class="ad-slot') > out.indexOf("<p>2</p>"), "pula para o próximo lugar possível");
    assert.equal(count(insertInContent(`${P(1)}<h2>T</h2>`, slot({ afterParagraph: 1 }))), 0);
    assert.equal(count(insertInContent(`${P(1)}<section class="faq"></section>`, slot({ afterParagraph: 1 }))), 0);
    assert.equal(count(insertInContent(P(1), slot({ afterParagraph: 1 }))), 0);
  });

  test("depois de título, fora de blocos protegidos: vai para o próximo parágrafo válido", () => {
    const AD = 'class="ad-slot';
    const after = (html: string, n: number) => insertInContent(html, slot({ afterParagraph: n }));
    // O parágrafo 2 vem antes de um título; o 3 vem logo depois dele e é seguido de outro parágrafo
    let out = after(`${P(1)}${P(2)}<h2>T</h2>${P(3)}${P(4)}`, 2);
    assert.ok(out.indexOf(AD) > out.indexOf("<p>3</p>") && out.indexOf(AD) < out.indexOf("<p>4</p>"));
    assert.doesNotMatch(out, /<\/h2>\s*<aside/, "nunca logo depois de um título");
    // Blocos protegidos: parágrafos internos não contam, e o anúncio não entra neles nem colado neles
    for (const cls of ["toc", "cta-box", "read-more", "author-box"]) {
      const block = `<aside class="${cls}"><p>a</p><p>b</p><p>c</p></aside>`;
      out = after(`${P(1)}${block}${P(2)}${P(3)}`, 1);
      const inside = out.slice(out.indexOf(`class="${cls}"`), out.indexOf("</aside>", out.indexOf(`class="${cls}"`)));
      assert.ok(!inside.includes(AD), `dentro de ${cls}`);
      assert.ok(out.indexOf(AD) > out.indexOf("<p>2</p>") && out.indexOf(AD) < out.indexOf("<p>3</p>"), `colado em ${cls}`);
    }
  });

  test("o CTA do meio do texto nunca fica colado no anúncio", () => {
    // O CTA entra antes do H2 número 2: mesmo pedindo o parágrafo imediatamente antes, o anúncio vai adiante
    const html = `${P(1)}<h2>A</h2>${P(2)}${P(3)}<h2>B</h2>${P(4)}${P(5)}`;
    const withAd = insertInContent(html, slot({ afterParagraph: 3 }));
    const slots = splitAt(withAd, [{ key: "cta", before: 2 }]);
    assert.equal(slots.length, 2);
    assert.doesNotMatch(slots[0]!.html, /<\/aside>\s*$/, "antes do CTA");
    assert.doesNotMatch(slots[0]!.html, /ad-slot/);
    assert.match(slots[1]!.html, /<p>4<\/p><aside class="ad-slot/);
  });

  test("o código fica inerte (escapado) até o consentimento", () => {
    const out = insertInContent(`${P(1)}${P(2)}`, slot({ afterParagraph: 1, code: '<script>alert("x")</script>' }));
    assert.ok(!out.includes("<script>"));
    assert.match(out, /data-ad-code="&lt;script&gt;alert\(&quot;x&quot;\)/);
    assert.match(out, /min-height:250px/);
    assert.match(out, /Publicidade/);
  });

  test("filtros de tipo de página e categoria", async () => {
    const res = await post("/admin/api/ads", {
      headScript: "",
      adsTxt: "google.com, pub-1, DIRECT",
      slots: { footer: slot({ pageTypes: ["article", "home"], includeCategories: [site.categories[0]!.id], excludeCategories: [] }) },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(activeSlot("footer", { type: "article", categoryId: site.categories[0]!.id }));
    assert.equal(activeSlot("footer", { type: "article", categoryId: site.categories[1]!.id }), null);
    assert.ok(activeSlot("footer", { type: "home" }), "o filtro de categoria não vale para a home");
    assert.equal(activeSlot("footer", { type: "category", categoryId: site.categories[0]!.id }), null);
    assert.equal(activeSlot("footer", undefined), null);
    assert.deepEqual(site.adsTxt, ["google.com, pub-1, DIRECT"]);
    assert.equal((await post("/admin/api/ads", { slots: { footer: slot({ code: " " }) } })).statusCode, 400);
    assert.equal((await post("/admin/api/ads", { slots: { footer: slot({ includeCategories: [99999] }) } })).statusCode, 400);
  });
});

describe("contraste", () => {
  test("mede e corrige", () => {
    assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
    assert.ok(contrastRatio(ensureReadable("#ffee00"), "#ffffff") >= 4.5);
    assert.equal(contrastWarnings({ primary: "#1363df" }).length, 0);
    assert.equal(contrastWarnings({ primary: "#ffee00" }).length, 1);
  });
});
