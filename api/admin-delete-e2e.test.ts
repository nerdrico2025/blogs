/**
 * Ponta a ponta, como em produção: publica com o simulador do Wordbee, exclui pelo painel,
 * roda o build real sob a trava global e confere o site publicado e o índice de busca.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-delete-e2e-"));
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
let base = "";
let cookie = "";
const read = (f: string) => readFileSync(path.join(current, f), "utf8");
const get = (url: string) => fetch(base + url, { redirect: "manual" });

/** Todo o texto do índice de busca (os fragmentos do Pagefind são JSON com gzip). */
function searchIndex(): string {
  const dir = path.join(current, "pagefind", "fragment");
  return readdirSync(dir).filter((f) => f.endsWith(".pf_fragment")).map((f) => gunzipSync(readFileSync(path.join(dir, f))).toString("utf8")).join("\n");
}

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
      globalBuildLockDir: path.join(tmp, "trava"),
      buildMode: "release",
      buildDebounceMs: 0,
      serveStatic: true,
      scheduler: false,
    }),
    { logger: false }
  );
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  const login = await ctx.app.inject({ method: "POST", url: "/admin/api/login", payload: { user: "chefe", password: "senha ficticia" } });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});

after(async () => {
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
});

test("simulador publica, painel exclui, e o artigo some de tudo; o slug pode voltar", { timeout: 400_000 }, async () => {
  // Um segundo artigo, da mesma categoria, para ter "Últimos artigos" e relacionados depois da exclusão
  const auth = { authorization: "Basic " + Buffer.from("wordbee:outra").toString("base64"), "content-type": "application/json" };
  const stays = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: auth, payload: { title: "Artigo que fica", content: "<p>Permanece no blog.</p>", status: "publish", categories: [(await ctx.app.inject({ url: "/wp-json/wp/v2/categories", headers: auth })).json()[0].id] } });
  assert.equal(stays.statusCode, 201, stays.body);

  await promisify(execFile)(process.execPath, ["scripts/simulate-wordbee.ts", base, "wordbee", "outra"], { timeout: 180_000 });
  await ctx.builds.drain();
  assert.equal(ctx.builds.getStatus().lastBuild?.ok, true, ctx.builds.getStatus().lastBuild?.error);

  const { posts } = (await ctx.app.inject({ url: "/admin/api/posts", headers: { cookie } })).json();
  const post = posts.find((p: { slug: string }) => p.slug.startsWith("teste-wordbee-"));
  assert.ok(post, "o simulador publicou");
  const { slug, title } = post as { slug: string; title: string };
  const url = `/${slug}/`;
  const cover = /src: (\/wp-content\/uploads\/\S+)/.exec(readFileSync(path.join(content, `${slug}.md`), "utf8"))![1]!;

  // Antes: está em tudo. Sem isto, os "sumiu" abaixo não provariam nada
  assert.equal((await get(url)).status, 200);
  assert.equal((await get(cover)).status, 200);
  for (const f of ["index.html", "sitemap.xml", "feed.xml", "sobre/index.html", "404.html"]) assert.ok(read(f).includes(slug), `antes, em ${f}`);
  const category = `/category/${/^category: (\S+)/m.exec(readFileSync(path.join(content, `${slug}.md`), "utf8"))![1]!}/`;
  assert.ok(read(`${category.slice(1)}index.html`).includes(slug), "antes, na categoria");
  assert.ok(searchIndex().includes(slug), "antes, na busca");

  const res = await ctx.app.inject({ method: "POST", url: "/admin/api/posts/delete", headers: { cookie }, payload: { slugs: [slug] } });
  assert.deepEqual(res.json().deleted, [slug]);
  assert.ok(!res.json().posts.some((p: { slug: string }) => p.slug === slug));
  await ctx.builds.drain();
  assert.equal(ctx.builds.getStatus().lastBuild?.ok, true, ctx.builds.getStatus().lastBuild?.error);
  assert.match(ctx.builds.getStatus().lastBuild!.reasons.join(), /exclusão/);

  assert.equal((await get(url)).status, 404);
  assert.equal((await get(`/2026/10/${slug}/`)).status, 404, "link antigo com data");
  assert.equal((await get(cover)).status, 404);
  assert.equal((await get(cover.replace(/\.[a-z]+$/, "-800.webp"))).status, 404);
  for (const f of ["index.html", "sitemap.xml", "feed.xml", "sobre/index.html", "404.html", `${category.slice(1)}index.html`]) {
    assert.ok(!read(f).includes(slug), `depois, fora de ${f}`);
    assert.ok(!read(f).includes(title), `título fora de ${f}`);
  }
  assert.ok(!searchIndex().includes(slug), "fora da busca");
  assert.ok(!existsSync(path.join(current, slug)));
  assert.ok(read("index.html").includes("Artigo que fica"), "o outro artigo continua");
  assert.ok(read("sitemap.xml").includes("artigo-que-fica"));
  assert.ok(existsSync(path.join(tmp, "lixeira")));
  assert.ok(readdirSync(path.join(tmp, "lixeira")).some((d) => d.endsWith(`-${slug}`)));

  const again = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: auth, payload: { title, content: "<p>Nova versão.</p>", status: "publish", slug } });
  assert.equal(again.statusCode, 201);
  assert.equal(again.json().slug, slug);
  await ctx.builds.drain();
  assert.equal((await get(url)).status, 200, "voltou como post novo");
  assert.match(read(`${slug}/index.html`), /Nova versão/);
});
