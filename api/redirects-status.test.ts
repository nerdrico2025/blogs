/**
 * redirects.txt com o tipo na 3ª coluna (301, 302, 307, 308): links curtos de afiliado ficam temporários.
 * E todo redirects.txt dos blogs do repositório precisa ser lido sem erro.
 */
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-redirect-status-"));
process.env.SITE = "exemplo";
process.env.SITE_URL = "https://principal.com.br";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
const { hashPassword } = await import("./auth.ts");
const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");
const { loadRedirectRules, loadRedirects } = await import("./static.ts");

const redirectsFile = path.join(tmp, "redirects.txt");
await writeFile(redirectsFile, "/velho/ /novo/\n/perm/ /novo/ 308\n/afiliado/ https://parceiro.example/x?a=1 307\n/temp/ /novo/ 302\n");
let ctx: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  ctx = await buildApp(
    loadEnv({ passwordHash: hashPassword("x"), contentDir: path.join(tmp, "posts"), uploadsDir: path.join(tmp, "uploads"), stateFile: path.join(tmp, "state.json"), secretsFile: path.join(tmp, "secrets.json"), buildMode: "none", serveStatic: true, scheduler: false, currentLink: path.join(tmp, "current"), redirectsFile, aliasHosts: ["velho.com.br"] }),
    { logger: false }
  );
});
after(async () => {
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("tipo do redirect", () => {
  test("sem 3ª coluna é 301; 307 e 302 saem como temporários e sem cache", async () => {
    const perm = await ctx.app.inject({ url: "/velho/" });
    assert.deepEqual([perm.statusCode, perm.headers.location], [301, "/novo/"]);
    assert.equal((await ctx.app.inject({ url: "/perm/" })).statusCode, 308);
    const aff = await ctx.app.inject({ url: "/afiliado/" });
    assert.deepEqual([aff.statusCode, aff.headers.location], [307, "https://parceiro.example/x?a=1"]);
    assert.equal(aff.headers["cache-control"], "no-store");
    assert.equal((await ctx.app.inject({ url: "/temp" })).statusCode, 302);
  });

  test("no domínio antigo (ALIAS_HOSTS), o link curto continua 307", async () => {
    const r = await ctx.app.inject({ url: "/afiliado/", headers: { host: "velho.com.br" } });
    assert.deepEqual([r.statusCode, r.headers.location], [307, "https://parceiro.example/x?a=1"]);
    assert.equal((await ctx.app.inject({ url: "/velho/", headers: { host: "velho.com.br" } })).statusCode, 301);
  });

  test("tipo desconhecido ou coluna a mais dão erro claro; loadRedirects continua devolvendo só os destinos", async () => {
    const bad = path.join(tmp, "ruim.txt");
    await writeFile(bad, "/a/ /b/ 404\n");
    assert.throws(() => loadRedirectRules(bad), /linha inválida/);
    await writeFile(bad, "/a/ /b/ 307 extra\n");
    assert.throws(() => loadRedirectRules(bad), /linha inválida/);
    assert.equal(loadRedirects(redirectsFile).get("/afiliado/"), "https://parceiro.example/x?a=1");
  });

  test("o redirects.txt de todo blog do repositório é lido sem erro", () => {
    for (const blog of readdirSync("sites")) {
      const f = path.join("sites", blog, "redirects.txt");
      if (existsSync(f)) assert.doesNotThrow(() => loadRedirectRules(f), blog);
    }
    const nerd = [...loadRedirectRules("sites/nerdrico/redirects.txt").values()];
    assert.equal(nerd.filter((r) => r.status === 307).length, 8);
    assert.ok(nerd.every((r) => r.status === 301 || r.status === 307));
  });
});
