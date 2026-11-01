/**
 * Aba Home, ponta a ponta: salva pela rota do painel, roda o build real e lê o site publicado.
 * Usa o blog asasdomundo, cujos valores de viagem são o padrão.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-home-"));
process.env.SITE = "asasdomundo";
process.env.SITE_URL = "https://blog.example";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
process.env.ADMIN_USER = "chefe";
const { hashPassword } = await import("./auth.ts");
process.env.ADMIN_PASSWORD_HASH = hashPassword("senha ficticia");
const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");
const { default: site } = await import("../site.config.ts");
const { applySettings, linkAttrs, sidebarBlockVisible } = await import("../shared/settings.ts");
const { parseHome, validHref } = await import("./settings-store.ts");
const { default: base } = await import("../sites/_base/site.config.ts");

let ctx: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";
const current = path.join(tmp, "current");
const page = () => readFileSync(path.join(current, "index.html"), "utf8");
const saveHome = (payload: object, headers: Record<string, string> = {}) => ctx.app.inject({ method: "POST", url: "/admin/api/home", headers: { cookie, ...headers }, payload });
const state = async () => (await ctx.app.inject({ url: "/admin/api/state", headers: { cookie } })).json();

const HOME = {
  tools: {
    enabled: true,
    icon: "🥕",
    title: "Vai cozinhar?",
    text: "Utensílios <b>recomendados</b>.",
    items: [
      { icon: "🍳", label: "Panelas", href: "https://parceiro.example/panelas" },
      { icon: "🔪", label: "Facas", href: "/category/dicas/" },
      { icon: "", label: "Sem link", href: "" },
    ],
    button: { label: "Ver loja", href: "https://parceiro.example/" },
  },
  callout: { enabled: true, icon: "📗", kicker: "Novo", title: "Livro de receitas", text: "Baixe agora.", button: { label: "Conhecer", href: "/sobre/" } },
  ticker: { enabled: true, showRates: false, showClocks: true, clocks: [{ label: "Roma", timezone: "Europe/Rome" }] },
  footerText: "Rodapé de cozinha <script>alert(1)</script>",
  searchPlaceholder: 'Ex.: "bolo"',
};

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

describe("padrões", () => {
  test("asasdomundo mantém os valores de viagem", async () => {
    const { home } = await state();
    assert.equal(home.tools.title, "Vai viajar?");
    assert.equal(home.tools.items.length, 5);
    assert.equal(home.callout.title, "Guias de Viagem");
    assert.equal(home.callout.button.href, "/category/roteiros/");
    assert.deepEqual([home.ticker.enabled, home.ticker.showRates, home.ticker.showClocks, home.ticker.clocks.length], [true, true, true, 5]);
  });

  test("blog novo do assistente: tudo desligado", () => {
    assert.equal(base.sidebar.tools.enabled, false);
    assert.equal(base.sidebar.callout.enabled, false);
    assert.equal(base.ticker.enabled, false);
  });

  test("ligar as cotações num blog novo tem moedas para mostrar", () => {
    const out = applySettings(base, { home: { ticker: { enabled: true, showRates: true, showClocks: false, clocks: [] } } });
    assert.deepEqual(out.ticker.rates.map((r) => r.code), ["USD", "EUR"]);
  });
});

describe("regras", () => {
  test("links: interno e http(s) passam; o resto não", () => {
    for (const ok of ["/sobre/", "/category/x/?a=1#b", "https://a.example/x", "http://a.example"]) assert.ok(validHref(ok), ok);
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "//mal.example", "/\\mal.example", "sobre", "https://", " https://a.example", "ftp://a.example"]) assert.ok(!validHref(bad), bad);
  });

  test("link externo ganha rel e target; interno e do próprio domínio não", () => {
    assert.deepEqual(linkAttrs("https://a.example/x", "https://blog.example"), { href: "https://a.example/x", rel: "sponsored noopener", target: "_blank" });
    assert.deepEqual(linkAttrs("/sobre/", "https://blog.example"), { href: "/sobre/" });
    assert.deepEqual(linkAttrs("https://blog.example/sobre/", "https://blog.example"), { href: "https://blog.example/sobre/" });
  });

  test("caixa ligada sem itens ou sem título não aparece", () => {
    const empty = applySettings(base, { home: { tools: { ...HOME.tools, items: [] }, callout: { ...HOME.callout, title: "" } } });
    assert.equal(sidebarBlockVisible(empty, "tools"), false);
    assert.equal(sidebarBlockVisible(empty, "callout"), false);
  });

  for (const [name, payload, message] of [
    ["sétimo item", { tools: { ...HOME.tools, items: Array.from({ length: 7 }, () => ({ label: "x" })) } }, /máximo 6/],
    ["item sem texto", { tools: { ...HOME.tools, items: [{ href: "/sobre/" }] } }, /precisa de texto/],
    ["link perigoso", { tools: { ...HOME.tools, button: { label: "x", href: "javascript:alert(1)" } } }, /endereço/],
    ["botão pela metade", { callout: { ...HOME.callout, button: { label: "x", href: "" } } }, /os dois vazios/],
    ["caixa ligada sem título", { callout: { ...HOME.callout, title: " " } }, /título/],
    ["texto longo", { footerText: "x".repeat(501) }, /longo demais/],
    ["fuso inválido", { ticker: { ...HOME.ticker, clocks: [{ label: "Lua", timezone: "Lua/Base" }] } }, /Fuso/],
    ["cidade sem fuso", { ticker: { ...HOME.ticker, clocks: [{ label: "Lua", timezone: "" }] } }, /Fuso/],
  ] as const) {
    test(`recusa ${name}`, async () => {
      const res = await saveHome(payload);
      assert.equal(res.statusCode, 400, res.body);
      assert.match(res.json().message, message);
    });
  }

  test("sem login: 401; de outra origem: 403", async () => {
    const anon = await ctx.app.inject({ method: "POST", url: "/admin/api/home", payload: HOME });
    assert.equal(anon.statusCode, 401);
    const cross = await saveHome(HOME, { origin: "https://mal.example" });
    assert.equal(cross.statusCode, 403);
  });

  test("campos desconhecidos não são gravados", () => {
    const out = parseHome({ tools: { ...HOME.tools, extra: "x" }, outro: "y" });
    assert.deepEqual(Object.keys(out), ["tools"]);
    assert.ok(!("extra" in out.tools!));
  });
});

describe("publicação real", () => {
  test("o que foi salvo vai para o volume e para o site, com HTML escapado", { timeout: 180_000 }, async () => {
    const res = await saveHome(HOME);
    assert.equal(res.statusCode, 200, res.body);
    await ctx.builds.drain();
    assert.equal(ctx.builds.getStatus().lastBuild?.ok, true, ctx.builds.getStatus().lastBuild?.error);
    assert.equal(JSON.parse(readFileSync(process.env.SETTINGS_FILE!, "utf8")).home.tools.title, "Vai cozinhar?");
    assert.equal(site.sidebar.tools.title, "Vai cozinhar?");

    const html = page();
    assert.doesNotMatch(html, /Vai viajar|Guias de Viagem/);
    assert.match(html, /Vai cozinhar\?/);
    assert.match(html, /Livro de receitas/);
    assert.match(html, /Utensílios &(lt|#x3C|#60);b/);
    assert.doesNotMatch(html, /<b>recomendados|<script>alert\(1\)/);
    assert.match(html, /Rodapé de cozinha &(lt|#x3C|#60);script/);
    assert.match(html, /placeholder="Ex\.: &(quot|#34|#x22);bolo/);

    const tag = (text: string) => new RegExp(`<a [^>]*>${text}`).exec(html)?.[0] ?? "";
    for (const text of ["Panelas", "Ver loja"]) {
      assert.match(tag(text), /rel="sponsored noopener"/, text);
      assert.match(tag(text), /target="_blank"/, text);
    }
    for (const text of ["Facas", "Conhecer"]) {
      assert.ok(tag(text), text);
      assert.doesNotMatch(tag(text), /rel=|target=/, text);
    }

    assert.match(html, /class="ticker"/);
    assert.match(html, /Roma/);
    assert.match(html, /data-tz="Europe\/Rome"/);
    assert.doesNotMatch(html, /Dólar/);
  });

  test("desligado: nada de caixa nem faixa; a lista de cidades não se perde", { timeout: 180_000 }, async () => {
    const res = await saveHome({
      ...HOME,
      tools: { ...HOME.tools, enabled: false },
      callout: { ...HOME.callout, enabled: false },
      ticker: { ...HOME.ticker, enabled: false, showClocks: false },
      footerText: "",
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().home.ticker.clocks[0].label, "Roma");
    await ctx.builds.drain();
    assert.equal(ctx.builds.getStatus().lastBuild?.ok, true, ctx.builds.getStatus().lastBuild?.error);
    const html = page();
    assert.doesNotMatch(html, /class="card widget tools"|class="callout-card"|class="ticker"|class="footer-text"/);
  });
});

test("o contrato do Wordbee não muda", async () => {
  const auth = { authorization: "Basic " + Buffer.from("wordbee:outra").toString("base64") };
  const cats = await ctx.app.inject({ url: "/wp-json/wp/v2/categories", headers: auth });
  assert.equal(cats.statusCode, 200);
});
