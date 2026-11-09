/**
 * Duas origens no mesmo blog: cada post guarda de onde veio ("wordpress:<domínio>"), slug de outra
 * fonte vira conflito sem ser alterado, e o redirects.txt tem uma seção por origem.
 * Sobe o blog de verdade (api/server.ts, sem build) e dois WordPress falsos em hosts diferentes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tmp = await mkdtemp(path.join(os.tmpdir(), "origens-"));
process.env.SITE = "exemplo";
delete process.env.SITE_URL;
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");

const { hashPassword } = await import("../../api/auth.ts");
const { loadEnv } = await import("../../api/env.ts");
const { buildApp } = await import("../../api/server.ts");
const { loadRedirects } = await import("../../api/static.ts");
const { BLOCK_START, BLOCK_END, ORIGIN_PREFIX, mergeRedirects } = await import("./mapping.ts");

interface FakePost {
  id: number;
  slug: string;
  title: string;
  html: string;
  category: number;
  /** Outras categorias, além de `category`. */
  more?: number[];
  /** Data GMT (padrão 2024-01-10T10:00:00). */
  date?: string;
}

const NOTICIAS = [{ id: 1, slug: "noticias", name: "Notícias" }];

/** WordPress mínimo: as rotas que o importador lê, com uma categoria "noticias" (ou as passadas). */
/** Página do WordPress (rota /pages), com o endereço sem data. */
interface FakePage {
  id: number;
  slug: string;
  title: string;
  html: string;
}

function fakeWordPress(name: string, posts: FakePost[], cats = NOTICIAS, pages: FakePage[] = []) {
  let base = "";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const send = (data: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json", "X-WP-Total": String(posts.length), "X-WP-TotalPages": "1" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/wp-json/") return send({ name });
    if (url.pathname === "/wp-json/wp/v2/pages") {
      const wanted = url.searchParams.get("slug");
      return send(
        pages
          .filter((p) => !wanted || p.slug === wanted)
          .map((p) => ({ id: p.id, date_gmt: "2019-12-19T10:00:00", modified_gmt: "2019-12-19T10:00:00", slug: p.slug, link: `${base}/${p.slug}/`, title: { rendered: p.title }, content: { rendered: p.html }, excerpt: { rendered: "" } }))
      );
    }
    if (url.pathname === "/wp-json/wp/v2/categories") return send(cats.map((c) => ({ ...c, link: `${base}/category/${c.slug}/` })));
    if (url.pathname === "/wp-json/wp/v2/posts") {
      if (url.searchParams.get("_fields") === "slug,link") return send(posts.map((p) => ({ slug: p.slug, link: `${base}/2024/01/${p.slug}/` })));
      return send(
        posts.map((p) => ({
          id: p.id,
          date_gmt: p.date ?? "2024-01-10T10:00:00",
          modified_gmt: p.date ?? "2024-01-10T10:00:00",
          slug: p.slug,
          link: `${base}/2024/01/${p.slug}/`,
          title: { rendered: p.title },
          // "{BASE}" no HTML vira o endereço deste WordPress falso (links para o próprio domínio)
          content: { rendered: p.html.replaceAll("{BASE}", base) },
          excerpt: { rendered: "" },
          categories: [p.category, ...(p.more ?? [])],
          yoast_head_json: { title: p.title, description: "Resumo." },
        }))
      );
    }
    if (url.pathname.endsWith(".mp3") && !url.pathname.includes("sumido")) {
      const head = req.method === "HEAD";
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": "2048" });
      return void res.end(head ? undefined : Buffer.alloc(2048, 7));
    }
    res.writeHead(404).end();
  });
  return {
    server,
    start: async (host: string) => {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://${host}:${(server.address() as AddressInfo).port}`;
      return base;
    },
  };
}

let blog: Awaited<ReturnType<typeof buildApp>>;
let blogUrl = "";
const AUTH = { authorization: "Basic " + Buffer.from("wordbee:senha do teste").toString("base64") };
const redirectsFile = path.join(tmp, "redirects.txt");
// A origem A está em 127.0.0.1 e a B em localhost: domínios diferentes para o importador
const a = fakeWordPress("Site A", [{ id: 1, slug: "ola-mundo", title: "Olá do site A", html: "<p>Texto do A.</p>", category: 1 }]);
const b = fakeWordPress("Site B", [{ id: 7, slug: "ola-mundo", title: "Olá do site B", html: "<p>Texto do B.</p>", category: 1 }]);
let fromA = "";
let fromB = "";

async function importer(from: string, map: string, extra: string[] = [], redirects = redirectsFile): Promise<{ code: number; out: string }> {
  const file = path.join(tmp, `map-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(file, map);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/import-wordpress/import.ts", "--from", from, "--blog", "exemplo", "--categories", file, "--api", blogUrl, "--redirects", redirects, ...extra], {
      env: { ...process.env, IMPORT_BLOG_USER: "wordbee", IMPORT_BLOG_PASSWORD: "senha do teste" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const post = async (slug: string) => (await blog.app.inject({ url: `/wp-json/wp/v2/posts?slug=${slug}`, headers: AUTH })).json()[0];
const file = (slug: string) => readFileSync(path.join(tmp, "posts", `${slug}.md`), "utf8");

before(async () => {
  const env = loadEnv({
    user: "wordbee",
    passwordHash: hashPassword("senha do teste"),
    contentDir: path.join(tmp, "posts"),
    uploadsDir: path.join(tmp, "uploads"),
    stateFile: path.join(tmp, "state.json"),
    secretsFile: path.join(tmp, "secrets.json"),
    buildMode: "none",
    serveStatic: false,
    scheduler: false,
    rateLimitPerMinute: 10_000,
    currentLink: path.join(tmp, "current"),
  });
  blog = await buildApp(env, { logger: false });
  await blog.app.listen({ host: "127.0.0.1", port: 0 });
  blogUrl = `http://127.0.0.1:${(blog.app.server.address() as AddressInfo).port}`;
  fromA = await a.start("127.0.0.1");
  fromB = await b.start("localhost");
});

after(async () => {
  await blog.app.close();
  a.server.close();
  b.server.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("duas origens no mesmo blog", () => {
  test("o post guarda a origem, e a API devolve em meta.source", async () => {
    const r = await importer(fromA, "noticias => dicas\n");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ola-mundo: importado/);
    const p = await post("ola-mundo");
    assert.equal(p.meta.source, "wordpress:127.0.0.1");
    assert.match(file("ola-mundo"), /source: wordpress:127\.0\.0\.1/);
  });

  test("reimportar a mesma origem continua dando sem mudanças", async () => {
    const r = await importer(fromA, "noticias => dicas\n");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ola-mundo: sem mudanças/);
    assert.match(r.out, /Redirects:\s+0 novos/);
  });

  test("slug de outra origem: conflito, código 2, post e redirects intactos", async () => {
    const before = file("ola-mundo");
    const redirectsBefore = readFileSync(redirectsFile, "utf8");
    // Na simulação também aparece como conflito
    const dry = await importer(fromB, "noticias => roteiros\n", ["--dry-run"]);
    assert.match(dry.out, /ola-mundo: conflito: o slug já é de um post importado de 127\.0\.0\.1/);
    assert.equal(dry.code, 2);

    const r = await importer(fromB, "noticias => roteiros\n");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /Conflitos:\s+1/);
    assert.match(r.out, /ola-mundo: post importado de 127\.0\.0\.1/);
    assert.equal(file("ola-mundo"), before, "o post da origem A não muda");
    // /category/noticias/ é da origem A (→ dicas); a B queria → roteiros e fica de fora
    assert.match(r.out, /\/category\/noticias\/: queria → \/category\/roteiros\/, continua → \/category\/dicas\/ \(wordpress:127\.0\.0\.1\)/);
    const map = loadRedirects(redirectsFile);
    assert.equal(map.get("/category/noticias/"), "/category/dicas/");
    // Tudo o que a B traria estava em conflito (o post e a categoria): o arquivo não muda e não ganha seção da B
    const content = readFileSync(redirectsFile, "utf8");
    assert.ok(content.includes(`${ORIGIN_PREFIX}wordpress:127.0.0.1`));
    assert.equal(content.replace(/\n+$/, ""), redirectsBefore.replace(/\n+$/, ""));
  });

  test("slug de post do Wordbee também é conflito, e o relatório diz a fonte", async () => {
    const created = await blog.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: { title: "Do Wordbee", content: "<p>x</p>", status: "publish", slug: "do-wordbee" } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().meta.source, "wordbee");
    const c = fakeWordPress("Site C", [{ id: 3, slug: "do-wordbee", title: "Outro", html: "<p>y</p>", category: 1 }]);
    const fromC = await c.start("127.0.0.1");
    const before = file("do-wordbee");
    const r = await importer(fromC, "noticias => dicas\n");
    c.server.close();
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /do-wordbee: post publicado pelo Wordbee/);
    assert.equal(file("do-wordbee"), before);
  });

  test("post da importação antiga (source: wordpress) é adotado pela origem, e depois fica sem mudanças", async () => {
    const legacy = await blog.app.inject({ method: "POST", url: "/wp-json/wp/v2/posts", headers: AUTH, payload: { title: "Antigo", content: "<p>Texto antigo.</p>", status: "publish", slug: "antigo", meta: { source: "wordpress" } } });
    assert.equal(legacy.json().meta.source, "wordpress");
    const d = fakeWordPress("Site D", [{ id: 9, slug: "antigo", title: "Antigo", html: "<p>Texto antigo.</p>", category: 1 }]);
    const fromD = await d.start("localhost");
    try {
      const first = await importer(fromD, "noticias => dicas\n");
      assert.match(first.out, /antigo: atualizado/, first.out);
      assert.equal((await post("antigo")).meta.source, "wordpress:localhost");
      const second = await importer(fromD, "noticias => dicas\n");
      assert.match(second.out, /antigo: sem mudanças/, second.out);
    } finally {
      d.server.close();
    }
  });
});

describe("'-' no mapeamento (não importar)", () => {
  test("post só da categoria marcada é ignorado, sem falha; com outra categoria com regra, é importado", async () => {
    const cats = [...NOTICIAS, { id: 2, slug: "demo", name: "Demo" }];
    const e = fakeWordPress("Site E", [
      { id: 21, slug: "post-de-demo", title: "Running on the ground", html: "<p>demo</p>", category: 2 },
      { id: 22, slug: "post-misto", title: "Misto", html: "<p>misto</p>", category: 2, more: [1] },
    ], cats);
    const fromE = await e.start("127.0.0.1");
    try {
      const r = await importer(fromE, "noticias => dicas\ndemo => -\n");
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /post-de-demo: ignorado \(categoria demo marcada com "-"/);
      assert.match(r.out, /Ignorados:\s+1 /);
      assert.match(r.out, /Falhas:\s+0/);
      assert.match(r.out, /post-misto: importado/);
      assert.equal(await post("post-de-demo"), undefined);
      assert.equal((await post("post-misto")).categories[0], 3, "foi pela regra de noticias (dicas, id 3)");
      // Categoria ignorada não ganha redirect
      assert.ok(!readFileSync(redirectsFile, "utf8").includes("/category/demo/"));
    } finally {
      e.server.close();
    }
  });
});

describe("--since e --exclude", () => {
  test("post antigo e slugs da lista ficam de fora, sem falha e sem redirect; motivos separados no relatório", async () => {
    const cats = [...NOTICIAS, { id: 2, slug: "demo", name: "Demo" }];
    // O WordPress devolve o slug com acento decomposto e codificado (c + cedilha)
    const accented = encodeURIComponent("acoes-e-ac\u0327o\u0303es".normalize("NFD")).toLowerCase();
    const f = fakeWordPress("Site F", [
      { id: 31, slug: "de-2018", title: "Old demo", html: "<p>2018</p>", category: 1, date: "2018-11-18T10:00:00" },
      { id: 32, slug: "fora-do-tema", title: "Fora", html: "<p>x</p>", category: 1 },
      { id: 33, slug: accented, title: "Com acento", html: "<p>x</p>", category: 1 },
      { id: 34, slug: "demo-de-2018", title: "Demo", html: "<p>x</p>", category: 2, date: "2018-11-18T10:00:00" },
      { id: 35, slug: "fica", title: "Fica", html: "<p>fica</p>", category: 1, date: "2019-01-01T00:00:00" },
    ], cats);
    const fromF = await f.start("127.0.0.1");
    const list = path.join(tmp, "excluir.txt");
    // Acento composto (como se digita) e um slug que não existe
    await writeFile(list, `# comentário\nfora-do-tema   # fora do tema\nacoes-e-ações\nnao-existe\n`);
    try {
      const r = await importer(fromF, "noticias => dicas\ndemo => -\n", ["--since", "2019-01-01", "--exclude", list]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /de-2018: ignorado \(antes de 2019-01-01: publicado em 2018-11-18\)/);
      assert.match(r.out, /fora-do-tema: ignorado \(excluído pelo excluir\.txt\)/);
      assert.match(r.out, /Ignorados:\s+4 \(categoria com "-": 1; antes de 2019-01-01: 1; excluídos: 2; não são falha\)/);
      assert.match(r.out, /--exclude: o slug "nao-existe" não existe na origem/);
      assert.match(r.out, /fica: importado/, "a data do --since em si entra");
      for (const slug of ["de-2018", "fora-do-tema", "acoes-e-acoes", "demo-de-2018"]) assert.equal(await post(slug), undefined, slug);
      const red = readFileSync(redirectsFile, "utf8");
      for (const p of ["/2024/01/fora-do-tema/", "/2024/01/de-2018/", "/category/demo/"]) assert.ok(!red.includes(p), p);
    } finally {
      f.server.close();
    }
  });

  test("--since com data inválida e --exclude com arquivo inexistente param antes de tudo", async () => {
    const bad = await importer("http://127.0.0.1:1", "noticias => dicas\n", ["--since", "2019-13-45"]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /--since precisa de uma data no formato AAAA-MM-DD/);
    const missing = await importer("http://127.0.0.1:1", "noticias => dicas\n", ["--exclude", path.join(tmp, "nao-ha.txt")]);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /--exclude: o arquivo .* não existe/);
  });
});

describe("post:<slug>, --include-pages e links pelo redirects.txt manual", () => {
  test("regra de um post vence a da categoria; página vira post; links seguem a regra 301 e mantêm o link curto 307", async () => {
    const cats = [...NOTICIAS, { id: 2, slug: "blog", name: "Blog" }];
    const body = `<p>Veja <a href="{BASE}/pagina-velha/">a página</a>, <a href="{BASE}/curso/">o curso</a>, <a href="{BASE}/afiliado/">o link curto</a> e <a href="{BASE}/sumiu/">um caminho sem regra</a>.</p>`;
    const g = fakeWordPress("Site G", [
      { id: 41, slug: "so-no-blog", title: "Só no Blog", html: "<p>x</p>", category: 2 },
      { id: 42, slug: "com-links", title: "Com links", html: body, category: 1 },
    ], cats, [
      { id: 90, slug: "ebook-grande", title: "E-book Grande", html: `<h2>[artigo]E-book Grande</h2><h2>Capítulo I</h2><p>Texto do e-book.</p><h3>https://site.example</h3>` },
    ]);
    const base = await g.start("127.0.0.1");
    // Regras manuais: 301 encadeado, 301 para fora e um link curto 307
    const red = path.join(tmp, "redirects-g.txt");
    await writeFile(red, ["/pagina-velha/ /outra-pagina/", "/outra-pagina/ /category/dicas/", "/curso/ https://aluno.example/cursos", "/afiliado/ https://parceiro.example/x 307", ""].join("\n"));
    try {
      const map = "post:so-no-blog => roteiros\npost:ebook-grande => dicas\npost:nao-existe => dicas\nnoticias => dicas\nblog => dicas\n";
      const r = await importer(base, map, ["--include-pages", "ebook-grande"], red);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Páginas importadas como post: 1 \(ebook-grande\)/);
      assert.match(r.out, /mapeamento: "post:nao-existe" não existe na origem/);
      // Regra do post (roteiros, id 2) vence a da categoria "blog" (dicas)
      assert.equal((await post("so-no-blog")).categories[0], 2);
      // A página vira post no mesmo endereço, com a origem marcada, sem o título repetido e sem o "título" que é só um endereço
      const ebook = await post("ebook-grande");
      assert.equal(ebook.meta.source, "wordpress:127.0.0.1");
      assert.equal(ebook.categories[0], 3);
      const md = file("ebook-grande");
      assert.doesNotMatch(md, /\[artigo\]|## E-book Grande|site\.example/);
      assert.match(md, /^excerpt: "?Texto do e-book\."?$/m);
      assert.match(md, /## Capítulo I/);
      // Links: 301 encadeado vai direto ao destino final; destino externo também; o 307 fica no caminho local
      const links = file("com-links");
      assert.match(links, /\[a página\]\(\/category\/dicas\/\)/);
      assert.match(links, /\[o curso\]\(https:\/\/aluno\.example\/cursos\)/);
      assert.match(links, /\[o link curto\]\(\/afiliado\/\)/);
      assert.match(links, /\[um caminho sem regra\]\(\/sumiu\/\)/);
      assert.match(r.out, /Links internos sem destino conhecido: 1 em 1 caminho\(s\)/);
      assert.match(r.out, /\n  \/sumiu\/ \(1\)/);
    } finally {
      g.server.close();
    }
  });
});

describe("áudio e relatório de imagens", () => {
  test("sumário antigo sai, títulos ficam, índice à mão é listado e o MP3 errado vira o áudio certo", async () => {
    const toc = `<div id="ez-toc-container" class="ez-toc-v2_0_87"><p class="ez-toc-title">Índice do Artigo</p><a href="#" class="ez-toc-toggle"><span class="eztoc-hide">Toggle</span></a><nav><ul><li><a href="{BASE}/2024/01/com-sumario/#um">Um</a></li></ul></nav></div>`;
    const g = fakeWordPress("Site G", [
      { id: 61, slug: "com-sumario", title: "Com sumário", html: `<p>Abertura.</p><p>[thrive_leads id=&#8217;9762&#8242;]</p>${toc}<h2><span class="ez-toc-section" id="um"></span>Um<span class="ez-toc-section-end"></span></h2><p>Texto.</p><h3>Baixe</h3><p><a href="{BASE}/wp-content/uploads/errado.mp3">Versão MP3</a></p><p><a href="{BASE}/wp-content/uploads/z.zip">Zip</a></p>`, category: 1 },
      { id: 62, slug: "indice-a-mao", title: "Índice à mão", html: `<ul><li><a href="#a">A</a></li><li><a href="#b">B</a></li><li><a href="#c">C</a></li></ul><p>Texto.</p>`, category: 1 },
    ]);
    const base = await g.start("127.0.0.1");
    const rules = path.join(tmp, "drop-toc.txt");
    await writeFile(rules, `/wp-content/uploads/z.zip\npost:com-sumario /wp-content/uploads/errado.mp3 => ${base}/stream/certo.mp3\n`);
    try {
      const r = await importer(base, "noticias => dicas\n", ["--drop-links", rules], path.join(tmp, "redirects-toc.txt"));
      assert.equal(r.code, 0, r.out);
      const md = file("com-sumario");
      assert.doesNotMatch(md, /Índice do Artigo|Toggle|errado\.mp3|z\.zip|Zip|thrive_leads/);
      assert.match(md, /## Um/);
      assert.match(md, /### Baixe/);
      const src = /\[Versão MP3\]\((\/wp-content\/uploads\/\d{4}\/\d{2}\/certo\.mp3)\)/.exec(md)?.[1];
      assert.ok(src, md);
      assert.equal(readFileSync(path.join(tmp, "uploads", src!.slice("/wp-content/uploads/".length))).length, 2048);
      assert.match(file("indice-a-mao"), /\[A\]\(#a\)/);
      assert.match(r.out, /Sumários antigos removidos do corpo: 1 posts\n  - com-sumario/);
      assert.match(r.out, /Índices escritos à mão \(mantidos\): 1 posts\n  - indice-a-mao: 1 lista/);
      assert.match(r.out, /Links removidos do texto \(--drop-links\): 1/);
      assert.match(r.out, /Links trocados por áudio copiado \(--drop-links\): 1/);
    } finally {
      g.server.close();
    }
  });

  test("áudio trocado que não baixa: o post fica sem áudio e sem prometer o episódio", async () => {
    const g = fakeWordPress("Site G", [
      { id: 63, slug: "episodio-sem-audio", title: "Episódio sem áudio", html: `<p>Ouça agora mesmo e deixe o seu comentário.</p><h3>Baixe o episódio:</h3><p><a href="{BASE}/wp-content/uploads/errado.mp3">Versão MP3</a></p><h3>Assine o feed:</h3><p>Feed.</p>`, category: 1 },
    ]);
    const base = await g.start("127.0.0.1");
    const rules = path.join(tmp, "drop-sem-audio.txt");
    await writeFile(rules, `post:episodio-sem-audio /wp-content/uploads/errado.mp3 => ${base}/stream/sumido.mp3\n`);
    try {
      const r = await importer(base, "noticias => dicas\n", ["--drop-links", rules], path.join(tmp, "redirects-sem-audio.txt"));
      assert.equal(r.code, 0, r.out);
      const md = file("episodio-sem-audio");
      assert.doesNotMatch(md, /Ouça|Baixe o episódio|Versão MP3|\.mp3/);
      assert.match(md, /Deixe o seu comentário/);
      assert.match(md, /### Assine o feed:/);
      assert.match(r.out, /FALHA episodio-sem-audio: .*sumido\.mp3 \(HTTP 404\)/);
    } finally {
      g.server.close();
    }
  });

  test("copia o MP3 para o blog, reescreve o link e lista capas e imagens perdidas", async () => {
    const g = fakeWordPress("Site G", [
      { id: 51, slug: "episodio-um", title: "Episódio um", html: `<p><a href="{BASE}/wp-content/uploads/2017/03/ep1.mp3">MP3</a></p><p><a href="{BASE}/wp-content/uploads/2017/03/sumido.mp3">sem arquivo</a></p><p><img src="{BASE}/wp-content/uploads/nao-existe.jpg" alt="Foto boa"></p>`, category: 1 },
    ]);
    const base = await g.start("127.0.0.1");
    try {
      const r = await importer(base, "noticias => dicas\n", [], path.join(tmp, "redirects-audio.txt"));
      assert.equal(r.code, 0, r.out);
      const md = file("episodio-um");
      const src = /\[MP3\]\((\/wp-content\/uploads\/\d{4}\/\d{2}\/ep1\.mp3)\)/.exec(md)?.[1];
      assert.ok(src, md);
      assert.equal(readFileSync(path.join(tmp, "uploads", src!.slice("/wp-content/uploads/".length))).length, 2048);
      assert.match(md, /\[sem arquivo\]\(\/wp-content\/uploads\/2017\/03\/sumido\.mp3\)/);
      assert.match(r.out, /Áudios:       1 copiados, 1 com erro/);
      assert.match(r.out, /FALHA episodio-um: .*sumido\.mp3 \(HTTP 404\)/);
      assert.match(r.out, /Posts sem capa: 1 \(sem imagem destacada na origem: 1; capa que não baixa: 0\)/);
      assert.match(r.out, /Posts que perdem imagens no corpo: 1 \(1 imagens\)\n  - episodio-um: 1/);
      assert.match(readFileSync(path.join(tmp, "redirects-audio.txt"), "utf8"), /\/wp-content\/uploads\/2017\/03\/ep1\.mp3 \/wp-content\/uploads\/\d{4}\/\d{2}\/ep1\.mp3/);
    } finally {
      g.server.close();
    }
  });
});

describe("redirects.txt com seção por origem", () => {
  test("o asasdomundo não muda: sem regras novas, o arquivo fica igual; reimportado, as regras são as mesmas", async () => {
    const real = readFileSync("sites/asasdomundo/redirects.txt", "utf8");
    assert.equal(mergeRedirects(real, new Map(), "wordpress:asasdomundo.com.br").content, real);

    const own = new Map([...loadRedirects("sites/asasdomundo/redirects.txt")].filter(([from]) => real.split(BLOCK_START)[1]!.split(BLOCK_END)[0]!.includes(`${from} `)));
    assert.ok(own.size > 100);
    const once = mergeRedirects(real, own, "wordpress:asasdomundo.com.br");
    assert.deepEqual([once.added, once.conflicts.length, once.adopted], [0, 0, own.size]);
    const f = path.join(tmp, "asas.txt");
    await writeFile(f, once.content);
    assert.deepEqual(loadRedirects(f), loadRedirects("sites/asasdomundo/redirects.txt"), "o servidor vê exatamente os mesmos 301");
    // Segunda rodada: nada muda
    assert.equal(mergeRedirects(once.content, own, "wordpress:asasdomundo.com.br").content, once.content);
  });

  test("regra antiga com outro destino vira conflito e não é trocada", () => {
    const old = `${BLOCK_START}\n/a/ /x/\n${BLOCK_END}\n`;
    const r = mergeRedirects(old, new Map([["/a/", "/y/"], ["/b/", "/z/"]]), "wordpress:novo.com");
    assert.deepEqual(r.conflicts, [{ from: "/a/", to: "/y/", kept: "/x/", owner: "regra antiga sem origem" }]);
    assert.equal(r.added, 1);
    assert.equal(r.content, `${BLOCK_START}\n/a/ /x/\n${ORIGIN_PREFIX}wordpress:novo.com\n/b/ /z/\n${BLOCK_END}\n`);
  });
});
