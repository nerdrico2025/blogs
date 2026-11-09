/**
 * Prefixo das URLs de categoria por blog (categoryBase em site.config.ts). Um build real por blog, cada um
 * num processo próprio, porque o site.config.ts é escolhido pela variável SITE ao carregar.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

interface Report {
  base: string;
  page1: number;
  page2: number;
  wrongPrefix: number;
  wrongPrefixLocation?: string;
  wrongPrefixPage2: number;
  wrongPrefixPage2Location?: string;
  canonical?: string;
  sitemap: string;
  html: string;
  apiLink: string;
  card: boolean;
  nav: boolean;
  defaultImage: string;
  homeFallbacks: number;
  postOgImage?: string;
  postLdImage: boolean;
}

/** Roda no processo filho: faz o build de um blog com 11 posts numa categoria e faz os pedidos ao servidor. */
async function child(blog: string): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), `blog-catbase-${blog}-`));
  process.env.SITE = blog;
  process.env.SITE_URL = "https://blog.example";
  process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
  process.env.ASSETS_DIR = path.join(tmp, "assets");
  const { hashPassword } = await import("./auth.ts");
  const { loadEnv } = await import("./env.ts");
  const { buildApp } = await import("./server.ts");
  const { default: site } = await import("../site.config.ts");
  const { categoryBase } = await import("../shared/settings.ts");
  const posts = path.join(tmp, "posts");
  await mkdir(posts, { recursive: true });
  // A primeira categoria do menu que tem a paginação nas regras do blog (no nerdrico, 5 páginas)
  const slug = site.categories[0]!.slug;
  for (let i = 1; i <= 11; i++) {
    await writeFile(path.join(posts, `teste-${i}.md`), `---\ntitle: "Teste ${i}"\ndescription: "Resumo ${i}."\nexcerpt: "Resumo ${i}."\ndate: 2026-10-${String(i).padStart(2, "0")}T10:00:00-03:00\ncategory: ${slug}\nwpId: ${i}\n---\n\nTexto do post ${i}.\n`);
  }
  const ctx = await buildApp(
    loadEnv({
      user: "wordbee",
      passwordHash: hashPassword("senha"),
      contentDir: posts,
      uploadsDir: path.join(tmp, "uploads"),
      stateFile: path.join(tmp, "state.json"),
      secretsFile: path.join(tmp, "secrets.json"),
      buildCacheDir: path.join(tmp, "build-cache"),
      releasesDir: path.join(tmp, "releases"),
      currentLink: path.join(tmp, "current"),
      buildMode: "release",
      buildDebounceMs: 0,
      serveStatic: true,
      scheduler: false,
    }),
    { logger: false }
  );
  ctx.builds.request("teste");
  await ctx.builds.drain();
  const last = ctx.builds.getStatus().lastBuild;
  if (!last?.ok) throw new Error(`build falhou: ${last?.error}`);

  const base = categoryBase(site);
  const other = base === "category" ? "categoria" : "category";
  const get = (url: string) => ctx.app.inject({ url });
  const page1 = await get(`/${base}/${slug}/`);
  const page2 = await get(`/${base}/${slug}/page/2/`);
  const wrong = await get(`/${other}/${slug}/`);
  const wrong2 = await get(`/${other}/${slug}/page/2/`);
  const home = await get("/");
  const sitemap = await get("/sitemap.xml");
  const api = await ctx.app.inject({ url: "/wp-json/wp/v2/categories" });
  // Os posts deste teste não têm capa
  const post = await get("/teste-1/");
  const defaultImage = `https://blog.example${site.seo.defaultImage.src}`;
  const report: Report = {
    defaultImage,
    homeFallbacks: (home.body.match(/class="cover-fallback"/g) ?? []).length,
    postOgImage: /<meta property="og:image" content="([^"]+)"/.exec(post.body)?.[1],
    postLdImage: post.body.includes(`"image":["${defaultImage}"]`),
    base,
    page1: page1.statusCode,
    page2: page2.statusCode,
    wrongPrefix: wrong.statusCode,
    wrongPrefixLocation: wrong.headers.location as string | undefined,
    wrongPrefixPage2: wrong2.statusCode,
    wrongPrefixPage2Location: wrong2.headers.location as string | undefined,
    canonical: /<link rel="canonical" href="([^"]+)"/.exec(page1.body)?.[1],
    sitemap: sitemap.body,
    html: page1.body,
    apiLink: api.json().find((c: { slug: string }) => c.slug === slug).link,
    card: home.body.includes(`href="/${base}/${slug}/"`),
    nav: home.body.includes(`/${base}/${slug}/`),
  };
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
  process.stdout.write(`\n@@REPORT@@${JSON.stringify(report)}\n`);
  process.exit(0);
}

if (process.env.CATEGORY_BASE_CHILD) {
  await child(process.env.CATEGORY_BASE_CHILD);
} else {
  const self = fileURLToPath(import.meta.url);
  const run = (blog: string): Report => {
    const r = spawnSync(process.execPath, [self], { env: { ...process.env, CATEGORY_BASE_CHILD: blog }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
    const m = /@@REPORT@@(.*)/.exec(r.stdout ?? "");
    assert.ok(m, `sem relatório de ${blog}: ${r.stderr}\n${(r.stdout ?? "").slice(-2000)}`);
    return JSON.parse(m![1]!) as Report;
  };
  const rules = async (blog: string) => {
    process.env.SITE = "exemplo";
    process.env.SETTINGS_FILE = path.join(os.tmpdir(), "blog-catbase-sem-settings.json");
    const { loadRedirectRules } = await import("./static.ts");
    return loadRedirectRules(`sites/${blog}/redirects.txt`);
  };

  describe("nerdrico: categorias em /categoria/", () => {
    test("página e paginação em /categoria/; /category/ dá 301; canonical, sitemap, JSON-LD e API acompanham", { timeout: 320_000 }, () => {
      const r = run("nerdrico");
      assert.equal(r.base, "categoria");
      assert.equal(r.page1, 200);
      assert.equal(r.page2, 200);
      assert.deepEqual([r.wrongPrefix, r.wrongPrefixLocation], [301, "/categoria/email-marketing/"]);
      assert.deepEqual([r.wrongPrefixPage2, r.wrongPrefixPage2Location], [301, "/categoria/email-marketing/page/2/"]);
      assert.equal(r.canonical, "https://blog.example/categoria/email-marketing/");
      assert.match(r.sitemap, /https:\/\/blog\.example\/categoria\/email-marketing\//);
      assert.doesNotMatch(r.sitemap, /\/category\//);
      assert.doesNotMatch(r.html, /\/category\//, "nada na página cita o prefixo antigo (menu, breadcrumb, JSON-LD)");
      assert.equal(r.apiLink, "https://blog.example/categoria/email-marketing/");
      assert.ok(r.card && r.nav, "cartões e menu da home usam o prefixo novo");
      assert.ok(r.homeFallbacks > 0, "post sem capa mostra o logotipo no quadro da imagem");
      assert.equal(r.postOgImage, r.defaultImage);
      assert.ok(r.postLdImage, "JSON-LD do artigo sem capa usa a imagem padrão da marca");
    });

    test("redirects.txt: nenhum destino com /category/; cada categoria e sua paginação têm 301; slugs da origem vão para o destino novo", async () => {
      const map = await rules("nerdrico");
      for (const [from, r] of map) assert.ok(!r.to.startsWith("/category/"), `${from} → ${r.to}`);
      const pages: Record<string, number> = { "email-marketing": 5, copywriting: 1, estrategias: 8, "produtos-digitais": 2, trafego: 1, ferramentas: 3, mentalidade: 4 };
      for (const [slug, n] of Object.entries(pages)) {
        assert.deepEqual(map.get(`/category/${slug}/`), { to: `/categoria/${slug}/`, status: 301 });
        for (let p = 2; p <= n; p++) assert.equal(map.get(`/category/${slug}/page/${p}/`)?.to, `/categoria/${slug}/page/${p}/`);
      }
      assert.equal(map.get("/category/estrategia/")?.to, "/categoria/estrategias/");
    });

    test("paginação antiga: /secao/ e /category/ dão 301 para uma página que existe na categoria nova", async () => {
      const map = await rules("nerdrico");
      const pages: Record<string, number> = { "email-marketing": 5, copywriting: 1, estrategias: 8, "produtos-digitais": 2, trafego: 1, ferramentas: 3, mentalidade: 4 };
      assert.equal(map.get("/secao/estrategia/page/2/")?.to, "/categoria/estrategias/page/2/");
      assert.equal(map.get("/category/estrategia/page/2/")?.to, "/categoria/estrategias/page/2/");
      assert.equal(map.get("/secao/copy/e-mail-marketing/page/5/")?.to, "/categoria/email-marketing/page/5/");
      assert.equal(map.get("/secao/blog/page/21/")?.to, "/categoria/estrategias/page/8/", "além do fim vai para a última página");
      assert.equal(map.get("/secao/trafego/page/2/")?.to, "/categoria/trafego/", "categoria nova com uma página só");
      for (const [from, r] of map) {
        const m = /^\/categoria\/([^/]+)\/page\/(\d+)\/$/.exec(r.to);
        if (m) assert.ok(Number(m[2]) >= 2 && Number(m[2]) <= pages[m[1]!]!, `${from} → ${r.to}`);
      }
    });
  });

  for (const [blog, slug] of [["asasdomundo", "roteiros"], ["rendadinheiro", "renda-extra"]] as const) {
    describe(`${blog}: nenhum endereço muda`, () => {
      test("categoria em /category/; /categoria/ não existe", { timeout: 320_000 }, () => {
        const r = run(blog);
        assert.equal(r.base, "category");
        assert.equal(r.page1, 200);
        assert.equal(r.page2, 200);
        assert.equal(r.wrongPrefix, 404);
        assert.equal(r.wrongPrefixPage2, 404);
        assert.equal(r.canonical, `https://blog.example/category/${slug}/`);
        assert.match(r.sitemap, new RegExp(`https://blog\\.example/category/${slug}/`));
        assert.doesNotMatch(r.sitemap, /\/categoria\//);
        assert.doesNotMatch(r.html, /\/categoria\//);
        assert.equal(r.apiLink, `https://blog.example/category/${slug}/`);
        assert.equal(r.postOgImage, r.defaultImage);
      });

      test("redirects.txt sem nenhuma regra para /categoria/", async () => {
        for (const [from, r] of await rules(blog)) assert.ok(!r.to.startsWith("/categoria/"), `${from} → ${r.to}`);
      });
    });
  }

  test("categoryBase inválido é recusado; sem ele, o padrão é category", async () => {
    const { defineSiteConfig } = await import("../src/lib/config-schema.ts");
    const { categoryBase, categoryUrl } = await import("../shared/settings.ts");
    assert.equal(categoryBase({}), "category");
    assert.equal(categoryUrl({}, "x"), "/category/x/");
    assert.equal(categoryUrl({ categoryBase: "categoria" }, "x"), "/categoria/x/");
    const minimal = { url: "https://a.example", categories: [], authors: { a: {} }, defaultAuthor: "a" } as unknown as Parameters<typeof defineSiteConfig>[0];
    assert.throws(() => defineSiteConfig({ ...minimal, categoryBase: "Com Espaço" }), /categoryBase/);
    assert.ok(existsSync("sites/nerdrico/redirects.txt") && readFileSync("sites/nerdrico/redirects.txt", "utf8").includes("/category/trafego/ /categoria/trafego/"));
  });
}
