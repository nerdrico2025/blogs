/**
 * ALIAS_HOSTS: domínio antigo que só redireciona. Regra do redirects.txt primeiro, depois 301 para o
 * domínio em uso, num salto só. Sem a variável, nada muda.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-alias-"));
process.env.SITE = "exemplo";
process.env.SITE_URL = "https://principal.com.br";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");

const { hashPassword } = await import("./auth.ts");
const { hostKey, loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");
type Ctx = Awaited<ReturnType<typeof buildApp>>;

// "ç" e "õ" decompostos (c + cedilha, o + til), como o WordPress grava em alguns slugs
const ACCENT_NFD = "/a-logica-das-ações/";
const redirectsFile = path.join(tmp, "redirects.txt");
await writeFile(
  redirectsFile,
  [
    "/category/forex/ /category/investimentos/",
    "/wp-content/uploads/2022/03/foto.png /wp-content/uploads/2026/11/foto.jpg",
    `${ACCENT_NFD} /a-logica-das-acoes/`,
    "/parceiro/ https://parceiro.example/pagina",
    "",
  ].join("\n")
);

const make = (aliasHosts: string[]) =>
  buildApp(
    loadEnv({
      user: "wordbee",
      passwordHash: hashPassword("x"),
      contentDir: path.join(tmp, "posts"),
      uploadsDir: path.join(tmp, "uploads"),
      stateFile: path.join(tmp, "state.json"),
      secretsFile: path.join(tmp, "secrets.json"),
      buildMode: "none",
      serveStatic: true,
      scheduler: false,
      currentLink: path.join(tmp, "current"),
      redirectsFile,
      aliasHosts,
    }),
    { logger: false }
  );

let withAlias: Ctx;
let without: Ctx;
const get = (ctx: Ctx, host: string, url: string, method: "GET" | "HEAD" | "POST" = "GET") => ctx.app.inject({ method, url, headers: { host } });

before(async () => {
  // O próprio domínio na lista (com maiúsculas e porta) é ignorado: nunca redireciona para si mesmo
  withAlias = await make(["velho.com.br", "www.velho.com.br", hostKey("Principal.com.br:443")]);
  without = await make([]);
});

after(async () => {
  await withAlias.app.close();
  await without.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("ALIAS_HOSTS", () => {
  test("hostKey: sem maiúsculas, sem porta, sem ponto no fim", () => {
    assert.equal(hostKey("Velho.COM.br:8443"), "velho.com.br");
    assert.equal(hostKey("velho.com.br."), "velho.com.br");
    assert.equal(hostKey("[::1]:8080"), "[::1]");
  });

  test("caminho sem regra: 301 para o domínio em uso, mesmo caminho e query", async () => {
    const r = await get(withAlias, "velho.com.br", "/um-post/?utm_source=x&b=2");
    assert.equal(r.statusCode, 301);
    assert.equal(r.headers.location, "https://principal.com.br/um-post/?utm_source=x&b=2");
  });

  test("host em maiúsculas e com porta também é alias", async () => {
    const r = await get(withAlias, "WWW.Velho.com.br:443", "/");
    assert.equal(r.statusCode, 301);
    assert.equal(r.headers.location, "https://principal.com.br/");
  });

  test("regra do redirects.txt primeiro: um salto só, até o destino final", async () => {
    const r = await get(withAlias, "velho.com.br", "/category/forex/");
    assert.equal(r.headers.location, "https://principal.com.br/category/investimentos/");
    // Sem a barra no fim também
    assert.equal((await get(withAlias, "velho.com.br", "/category/forex")).headers.location, "https://principal.com.br/category/investimentos/");
    // Destino absoluto no redirects.txt é respeitado
    assert.equal((await get(withAlias, "velho.com.br", "/parceiro/")).headers.location, "https://parceiro.example/pagina");
  });

  test("imagem antiga em /wp-content/uploads/ vai para a imagem nova", async () => {
    const r = await get(withAlias, "velho.com.br", "/wp-content/uploads/2022/03/foto.png");
    assert.equal(r.statusCode, 301);
    assert.equal(r.headers.location, "https://principal.com.br/wp-content/uploads/2026/11/foto.jpg");
  });

  test("caminho com acento: vale a grafia do WordPress (%CC%A7) e a do navegador (%C3%A7)", async () => {
    for (const url of ["/a-logica-das-ac%CC%A7o%CC%83es/", "/a-logica-das-a%C3%A7%C3%B5es/", "/a-logica-das-a%c3%a7%c3%b5es"]) {
      const r = await get(withAlias, "velho.com.br", url);
      assert.equal(r.headers.location, "https://principal.com.br/a-logica-das-acoes/", url);
    }
    // No domínio principal, a mesma regra também passa a aceitar as duas grafias
    const main = await get(withAlias, "principal.com.br", "/a-logica-das-a%C3%A7%C3%B5es/");
    assert.equal(main.statusCode, 301);
    assert.equal(main.headers.location, "/a-logica-das-acoes/");
  });

  test("pedido que começa com // continua no domínio do blog", async () => {
    const r = await get(withAlias, "velho.com.br", "//outro-site.example/x");
    assert.equal(new URL(r.headers.location as string).host, "principal.com.br");
  });

  test("HEAD redireciona; POST e outros métodos recebem 404", async () => {
    assert.equal((await get(withAlias, "velho.com.br", "/x/", "HEAD")).statusCode, 301);
    const p = await get(withAlias, "velho.com.br", "/wp-json/wp/v2/posts", "POST");
    assert.equal(p.statusCode, 404);
  });

  test("domínio principal, endereço provisório e healthcheck local não são afetados", async () => {
    for (const host of ["principal.com.br", "Principal.com.br:443", "blogs-x.n5v7wx.easypanel.host", "127.0.0.1:8080"]) {
      const r = await get(withAlias, host, "/health");
      assert.equal(r.statusCode, 200, host);
    }
  });

  test("sem ALIAS_HOSTS, o domínio antigo é tratado como hoje (sem 301 de domínio)", async () => {
    assert.equal((await get(without, "velho.com.br", "/health")).statusCode, 200);
    const rule = await get(without, "velho.com.br", "/category/forex/");
    assert.equal(rule.headers.location, "/category/investimentos/");
  });

  test("a variável aceita vírgula, espaço, https:// e barra no fim", () => {
    const saved = process.env.ALIAS_HOSTS;
    process.env.ALIAS_HOSTS = "https://Velho.com.br/, www.velho.com.br:443  velho.com.br";
    try {
      assert.deepEqual(loadEnv().aliasHosts, ["velho.com.br", "www.velho.com.br"]);
    } finally {
      if (saved === undefined) delete process.env.ALIAS_HOSTS;
      else process.env.ALIAS_HOSTS = saved;
    }
  });
});
