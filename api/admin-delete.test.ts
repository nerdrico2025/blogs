/** Exclusão de artigos pelo painel: regras de imagens, lixeira, idempotência e segurança, sem build. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-delete-"));
process.env.SITE = "exemplo";
process.env.SITE_URL = "https://blog.example";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
process.env.ADMIN_USER = "chefe";
const { hashPassword } = await import("./auth.ts");
process.env.ADMIN_PASSWORD_HASH = hashPassword("senha ficticia");
const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");
const { cleanTrash } = await import("./trash.ts");

const trash = path.join(tmp, "lixeira");
const uploads = path.join(tmp, "uploads");
const content = path.join(tmp, "posts");
let ctx: Awaited<ReturnType<typeof buildApp>>;
let cookie = "";
const auth = { authorization: "Basic " + Buffer.from("wordbee:outra").toString("base64") };
const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#369" } }).png().toBuffer();

const upload = async (name: string) => {
  const res = await ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/media", headers: { ...auth, "content-type": "image/png", "content-disposition": `attachment; filename="${name}.png"` }, payload: png });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: number; source_url: string; media_details: { file: string } };
};
const publish = (payload: object) => ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: { ...auth, "content-type": "application/json" }, payload: { status: "publish", ...payload } });
const remove = (slugs: unknown, headers: Record<string, string> = {}) => ctx.app.inject({ method: "POST", url: "/admin/api/posts/delete", headers: { cookie, ...headers }, payload: { slugs } });
const onDisk = (media: { media_details: { file: string } }) => existsSync(path.join(uploads, media.media_details.file));
const stem = (media: { media_details: { file: string } }) => path.join(uploads, media.media_details.file.replace(/\.jpg$/, ""));

before(async () => {
  ctx = await buildApp(loadEnv({ user: "wordbee", passwordHash: hashPassword("outra"), contentDir: content, uploadsDir: uploads, stateFile: path.join(tmp, "state.json"), secretsFile: path.join(tmp, "secrets.json"), trashDir: trash, pagesDir: path.join(tmp, "pages"), buildMode: "none", serveStatic: true, currentLink: path.join(tmp, "current"), scheduler: false }), { logger: false });
  const login = await ctx.app.inject({ method: "POST", url: "/admin/api/login", payload: { user: "chefe", password: "senha ficticia" } });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});
after(async () => {
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("acesso", () => {
  test("sem login: 401 ao listar e ao excluir", async () => {
    assert.equal((await ctx.app.inject({ url: "/admin/api/posts" })).statusCode, 401);
    assert.equal((await ctx.app.inject({ method: "POST", url: "/admin/api/posts/delete", payload: { slugs: ["x"] } })).statusCode, 401);
  });
  test("de outra origem: 403, e o artigo continua", async () => {
    const created = (await publish({ title: "Protegido", content: "<p>a</p>" })).json();
    const res = await remove([created.slug], { origin: "https://mal.example" });
    assert.equal(res.statusCode, 403);
    assert.ok(existsSync(path.join(content, `${created.slug}.md`)));
  });
  test("slug com caminho não apaga nada fora dos posts", async () => {
    writeFileSync(path.join(tmp, "fora.md"), "x");
    const res = await remove(["../fora", "..%2Ffora", "/etc/passwd"]);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().deleted.length, 0);
    assert.equal(res.json().missing.length, 3);
    assert.ok(existsSync(path.join(tmp, "fora.md")));
  });
  test("lista vazia ou inválida: 400", async () => {
    assert.equal((await remove([])).statusCode, 400);
    assert.equal((await remove("x")).statusCode, 400);
    assert.equal((await remove([1])).statusCode, 400);
  });
});

test("a lista traz título, categoria, data e status, inclusive rascunho e post sem wpId", async () => {
  await publish({ title: "Rascunho da lista", content: "<p>r</p>", status: "draft" });
  writeFileSync(path.join(content, "manual.md"), "---\ntitle: Post manual\ndate: 2020-01-02\ncategory: dicas\n---\n\nTexto\n");
  const { posts } = (await ctx.app.inject({ url: "/admin/api/posts", headers: { cookie } })).json();
  const draft = posts.find((p: { title: string }) => p.title === "Rascunho da lista");
  assert.equal(draft.status, "draft");
  assert.ok(draft.date && draft.category);
  const manual = posts.find((p: { slug: string }) => p.slug === "manual");
  assert.equal(manual.title, "Post manual");
  assert.equal(manual.category, "Dicas");
  assert.equal(posts.at(-1).slug, "manual", "do mais novo para o mais antigo");
  assert.deepEqual((await remove(["manual"])).json().deleted, ["manual"]);
});

describe("imagens", () => {
  test("apaga o que só ele usa; a imagem de outro post, a da página e a de nome parecido ficam", async () => {
    const own = await upload("so-dele");
    const inBody = await upload("no-corpo");
    const shared = await upload("compartilhada");
    const inPage = await upload("na-pagina");
    const lookalike = await upload("so-dele-2");
    mkdirSync(path.join(tmp, "pages"), { recursive: true });
    writeFileSync(path.join(tmp, "pages", "guia.md"), `---\ntitle: Guia\n---\n\n![x](${inPage.source_url})\n`);
    await publish({ title: "Outro", content: `<p>t</p><img src="${shared.source_url.replace(/\.jpg$/, "-800.webp")}" alt="x">`, featured_media: lookalike.id });
    const target = (await publish({ title: "Alvo", content: `<p>t</p><img src="${inBody.source_url}" alt="a"><img src="${shared.source_url}" alt="b"><img src="${inPage.source_url}" alt="c">`, featured_media: own.id })).json();

    const res = await remove([target.slug]);
    assert.deepEqual(res.json().deleted, [target.slug]);
    assert.ok(!existsSync(path.join(content, `${target.slug}.md`)));

    for (const m of [own, inBody]) {
      assert.ok(!onDisk(m));
      for (const suffix of [".webp", "-160.webp", "-480.webp", "-800.webp", "-og.jpg", ".json"]) assert.ok(!existsSync(stem(m) + suffix), suffix);
    }
    for (const m of [shared, inPage, lookalike]) {
      assert.ok(onDisk(m), m.source_url);
      assert.ok(existsSync(stem(m) + "-480.webp"));
    }
    const state = JSON.parse(readFileSync(path.join(tmp, "state.json"), "utf8"));
    assert.equal(state.media[own.id], undefined);
    assert.ok(state.media[shared.id]);

    const folder = readdirSync(trash).find((d) => d.endsWith(`-${target.slug}`))!;
    assert.match(folder, /^\d{4}-\d{2}-\d{2}-/);
    const copy = path.join(trash, folder);
    assert.match(readFileSync(path.join(copy, `${target.slug}.md`), "utf8"), /title: Alvo/);
    const rel = own.media_details.file;
    assert.ok(existsSync(path.join(copy, "uploads", rel)));
    assert.ok(existsSync(path.join(copy, "uploads", rel.replace(/\.jpg$/, "-800.webp"))));
    assert.ok(!existsSync(path.join(copy, "uploads", shared.media_details.file)), "imagem que ficou não é copiada");
    assert.equal(JSON.parse(readFileSync(path.join(copy, "manifest.json"), "utf8")).post.id, target.id);
  });

  test("dois artigos com a mesma imagem, excluídos juntos: ela sai e fica na lixeira", async () => {
    const m = await upload("dupla");
    const a = (await publish({ title: "Dupla A", content: "<p>a</p>", featured_media: m.id })).json();
    const b = (await publish({ title: "Dupla B", content: "<p>b</p>", featured_media: m.id })).json();
    assert.deepEqual((await remove([a.slug, b.slug])).json().deleted, [a.slug, b.slug]);
    assert.ok(!onDisk(m));
    const folder = readdirSync(trash).find((d) => d.endsWith(`-${b.slug}`))!;
    assert.ok(existsSync(path.join(trash, folder, "uploads", m.media_details.file)));
  });

  test("a lixeira não é servida ao público", async () => {
    for (const url of ["/lixeira/", "/data/lixeira/", "/wp-content/uploads/../lixeira/"]) assert.notEqual((await ctx.app.inject({ url })).statusCode, 200, url);
  });
});

describe("Wordbee depois de excluir", () => {
  const body = { title: "Volta", content: "<p>mesmo texto</p>", slug: "volta" };

  test("repetido antes de excluir devolve o mesmo; depois, é um post novo com o mesmo slug e outro id", async () => {
    const first = await publish(body);
    assert.equal(first.statusCode, 201);
    assert.equal((await publish(body)).json().id, first.json().id);
    await remove(["volta"]);
    const again = await publish(body);
    assert.equal(again.statusCode, 201);
    assert.equal(again.json().slug, "volta");
    assert.ok(again.json().id > first.json().id, "o id não é reaproveitado");
    assert.deepEqual(Object.keys(again.json()).sort(), Object.keys(first.json()).sort(), "mesma resposta de sempre");
  });

  test("imagem excluída: id antigo dá 400; novo envio com o mesmo nome ganha outro endereço", async () => {
    const m = await upload("repete");
    const p = (await publish({ title: "Com imagem", content: "<p>x</p>", featured_media: m.id })).json();
    await remove([p.slug]);
    const old = await publish({ title: "Com imagem", content: "<p>x</p>", featured_media: m.id });
    assert.equal(old.statusCode, 400);
    assert.equal(old.json().code, "rest_invalid_featured_media");
    const next = await upload("repete");
    assert.notEqual(next.source_url, m.source_url);
    assert.ok(next.id > m.id);
  });

  test("os contadores sobrevivem ao reinício", async () => {
    const p = (await publish({ title: "Último", content: "<p>u</p>" })).json();
    await remove([p.slug]);
    const again = await buildApp(loadEnv({ user: "wordbee", passwordHash: hashPassword("outra"), contentDir: content, uploadsDir: uploads, stateFile: path.join(tmp, "state.json"), secretsFile: path.join(tmp, "secrets.json"), trashDir: trash, buildMode: "none", serveStatic: false, scheduler: false }), { logger: false });
    const res = await again.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: { ...auth, "content-type": "application/json" }, payload: { title: "Último", content: "<p>u</p>", status: "publish" } });
    assert.equal(res.statusCode, 201);
    assert.ok(res.json().id > p.id);
    await again.app.close();
  });
});

describe("falhas e lixeira", () => {
  test("se a cópia falhar, nada é apagado e o painel não mostra caminhos", { skip: process.getuid?.() === 0 }, async () => {
    const m = await upload("segura");
    const p = (await publish({ title: "Segura", content: "<p>s</p>", featured_media: m.id })).json();
    await chmod(trash, 0o500);
    try {
      const res = await remove([p.slug]);
      assert.deepEqual(res.json().failed, [p.slug]);
      assert.ok(!res.body.includes(tmp), "sem caminhos do volume");
    } finally {
      await chmod(trash, 0o700);
    }
    assert.ok(existsSync(path.join(content, `${p.slug}.md`)));
    assert.ok(onDisk(m));
    assert.equal((await publish({ title: "Segura", content: "<p>s</p>" })).statusCode, 200, "continua sendo o mesmo post");
  });

  test("limpeza: só pasta da lixeira mais velha que o prazo", async () => {
    const dir = path.join(tmp, "lixeira-limpeza");
    const now = new Date("2026-10-31T12:00:00Z");
    for (const name of ["2026-09-30-velho", "2026-10-02-recente", "backup-importante", "2020-01-01"]) mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, "2020-01-01-arquivo"), "x");
    const alvo = path.join(tmp, "alvo-do-link");
    mkdirSync(alvo);
    writeFileSync(path.join(alvo, "f"), "x");
    symlinkSync(alvo, path.join(dir, "2020-01-02-link"));
    assert.equal(await cleanTrash(dir, 30, now), 1);
    assert.deepEqual(readdirSync(dir).sort(), ["2020-01-01", "2020-01-01-arquivo", "2020-01-02-link", "2026-10-02-recente", "backup-importante"]);
    assert.ok(existsSync(path.join(alvo, "f")));
    assert.equal(await cleanTrash(dir, 0, new Date("2099-01-01")), 0, "0 desliga");
  });
});
