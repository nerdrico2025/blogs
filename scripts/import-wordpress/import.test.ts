import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { loadRedirects } from "../../api/static.ts";
import { autop, finishHtml, originalCandidates, prepareHtml, stripShortcodes, weakAlt } from "./html.ts";
import { BLOCK_END, BLOCK_START, CategoryMapper, mergeRedirects, parseCategoryMap } from "./mapping.ts";
import { cleanPageHtml, expandSeoVars, readXml, stripSiteName } from "./source.ts";

const base = { base: "https://antigo.com.br", oldHosts: new Set(["antigo.com.br"]), postTitle: "Título do post" };
const prep = (html: string, resolveLink: (p: string) => string | null = () => null) => prepareHtml(html, { ...base, resolveLink });

describe("limpeza do HTML", () => {
  test("tira comentários do Gutenberg, classes, estilos, ids e atributos data-*", () => {
    const p = prep(`<!-- wp:paragraph --><p class="has-text-align-center" style="color:red" id="x" data-foo="1">Olá <span style="color:blue">mundo</span></p><!-- /wp:paragraph -->`);
    assert.equal(finishHtml(p, () => null), "<p>Olá mundo</p>");
  });

  test("shortcodes saem; o texto dentro fica; [1] e [sic] ficam", () => {
    const { html, removed } = stripShortcodes(`[caption id="a" align="x"]<img src="a.jpg"> Legenda[/caption] Nota [1] e [sic]. [gallery ids="1,2"] [toc]`);
    assert.equal(html, `<img src="a.jpg"> Legenda Nota [1] e [sic].  `);
    assert.deepEqual(removed.sort(), ["caption", "gallery", "toc"]);
  });

  test("título com negrito em volta vira só o título; parágrafo vazio sai", () => {
    const p = prep(`<h2><span style="x"><strong>Dica #1</strong></span></h2><p>&nbsp;</p><p>Texto</p>`);
    assert.equal(finishHtml(p, () => null), "<h2>Dica #1</h2><p>Texto</p>");
  });

  test("iframe do YouTube vira link; outros iframes e scripts saem", () => {
    const p = prep(`<div class="nv-iframe-embed"><iframe title="Meu vídeo" src="https://www.youtube.com/embed/xMfz1jlyQrw?feature=oembed"></iframe></div><iframe src="https://maps.google.com/x"></iframe><script>alert(1)</script>`);
    assert.equal(finishHtml(p, () => null), `<div><p><a href="https://www.youtube.com/watch?v=xMfz1jlyQrw">Vídeo: Meu vídeo</a></p></div>`);
    assert.equal(p.stats.videosLinked, 1);
    assert.equal(p.stats.embedsRemoved, 1);
  });

  test("texto cru do XML ganha parágrafos", () => {
    assert.equal(autop("Linha um\nlinha dois\n\n<h2>Título</h2>\n\nFim"), "<p>Linha um<br>\nlinha dois</p>\n<h2>Título</h2>\n<p>Fim</p>");
    assert.equal(autop("<p>já tem</p>"), "<p>já tem</p>");
  });
});

describe("imagens", () => {
  test("alt fraco (nome do arquivo) é gerado pela legenda ou pelo título; alt bom fica", () => {
    const p = prep(
      `<p><img src="http://antigo.com.br/wp-content/uploads/2016/08/P1010676.jpg" alt="P1010676" srcset="x 300w" width="10"></p>` +
        `<figure><img src="/wp-content/uploads/a.jpg" alt=""><figcaption>Ponte ao entardecer</figcaption></figure>` +
        `<p><img data-src="https://antigo.com.br/wp-content/uploads/b-300x200.jpg" src="data:image/gif;base64,AAA" alt="Praia de Copacabana"></p>`
    );
    assert.deepEqual(
      p.images.map((i) => [i.alt, i.altGenerated]),
      [["Título do post", true], ["Ponte ao entardecer", true], ["Praia de Copacabana", false]]
    );
    assert.deepEqual(p.images[2]!.candidates, ["https://antigo.com.br/wp-content/uploads/b.jpg", "https://antigo.com.br/wp-content/uploads/b-300x200.jpg"]);
  });

  test("troca o endereço da imagem e remove a que não baixou", () => {
    const p = prep(`<p><img src="https://antigo.com.br/wp-content/uploads/ok.jpg" alt="Foto boa"></p><p><img src="https://antigo.com.br/wp-content/uploads/falhou.jpg" alt="x"></p><figure><img src="https://antigo.com.br/wp-content/uploads/falhou2.jpg"><figcaption>Legenda</figcaption></figure>`);
    const html = finishHtml(p, (u) => (u.endsWith("ok.jpg") ? "/wp-content/uploads/2026/11/ok.jpg" : null));
    assert.equal(html, `<p><img src="/wp-content/uploads/2026/11/ok.jpg" alt="Foto boa"></p>`);
  });

  test("candidatas ao original", () => {
    assert.deepEqual(originalCandidates("https://s/wp-content/uploads/2020/01/foto-scaled.jpg"), ["https://s/wp-content/uploads/2020/01/foto.jpg", "https://s/wp-content/uploads/2020/01/foto-scaled.jpg"]);
    assert.deepEqual(originalCandidates("https://s/outra/foto-300x200.jpg"), ["https://s/outra/foto-300x200.jpg"]);
  });

  test("alts fracos", () => {
    for (const a of ["", "IMG_2034", "DSC-1", "image-3", "12345"]) assert.ok(weakAlt(a, "https://s/x.jpg"), a);
    assert.ok(weakAlt("minha-foto", "https://s/wp-content/uploads/minha-foto-300x200.jpg"));
    assert.ok(!weakAlt("Vista do Cristo Redentor", "https://s/x.jpg"));
  });
});

describe("links internos", () => {
  test("domínio antigo (com ou sem www, http ou https) vira caminho novo; outros sites ficam", () => {
    const map: Record<string, string> = { "/2016/08/post-velho/": "/post-velho/", "/category/lugares/": "/category/roteiros/" };
    const p = prep(
      `<p><a href="http://www.antigo.com.br/2016/08/post-velho/#parte" class="x" target="_blank" rel="noopener">a</a> ` +
        `<a href="https://antigo.com.br/category/lugares">b</a> <a href="https://antigo.com.br/pagina-sumida/">c</a> ` +
        `<a href="https://siga.antigo.com.br/7dicas">d</a> <a href="https://outro.com/">e</a></p>`,
      (p) => map[p] ?? null
    );
    assert.equal(
      finishHtml(p, () => null),
      `<p><a href="/post-velho/#parte">a</a> <a href="/category/roteiros/">b</a> <a href="/pagina-sumida/">c</a> <a href="https://siga.antigo.com.br/7dicas">d</a> <a href="https://outro.com/">e</a></p>`
    );
    assert.equal(p.stats.linksRewritten, 2);
    assert.deepEqual(p.stats.linksUnresolved, ["/pagina-sumida/"]);
  });

  test("link para a foto ampliada é desembrulhado", () => {
    const p = prep(`<p><a href="https://antigo.com.br/wp-content/uploads/foto.jpg"><img src="https://antigo.com.br/wp-content/uploads/foto-300x200.jpg" alt="Foto boa"></a></p>`);
    assert.equal(finishHtml(p, () => "/wp-content/uploads/2026/11/foto.jpg"), `<p><img src="/wp-content/uploads/2026/11/foto.jpg" alt="Foto boa"></p>`);
  });
});

describe("áudio da origem", () => {
  const NEW = "/wp-content/uploads/2026/11/ep.mp3";

  test("link para MP3 do domínio antigo vai para o endereço novo; o mesmo arquivo em http e https conta uma vez", () => {
    const p = prep(`<p><a href="http://antigo.com.br/wp-content/uploads/2017/03/ep.mp3">MP3</a> <a href="https://www.antigo.com.br/wp-content/uploads/2017/03/ep.mp3">de novo</a></p>`);
    assert.equal(p.audios.length, 1);
    assert.deepEqual(p.stats.linksUnresolved, []);
    assert.equal(finishHtml(p, () => null, () => NEW), `<p><a href="${NEW}">MP3</a> <a href="${NEW}">de novo</a></p>`);
  });

  test("áudio que não copiou fica no caminho antigo; áudio em outro site não é tocado", () => {
    const p = prep(`<p><a href="https://antigo.com.br/wp-content/uploads/ep.mp3">a</a> <a href="https://outro.com/x.mp3">b</a></p>`);
    assert.equal(p.audios.length, 1);
    assert.equal(finishHtml(p, () => null), `<p><a href="/wp-content/uploads/ep.mp3">a</a> <a href="https://outro.com/x.mp3">b</a></p>`);
  });

  test("player <audio> da origem vira link", () => {
    const p = prep(`<audio controls><source src="https://antigo.com.br/wp-content/uploads/ep.ogg" type="audio/ogg"></audio>`);
    assert.equal(p.audios.length, 1);
    assert.equal(finishHtml(p, () => null, () => "/wp-content/uploads/2026/11/ep.ogg"), `<p><a href="/wp-content/uploads/2026/11/ep.ogg">Ouça o áudio</a></p>`);
  });
});

describe("sumário antigo do WordPress", () => {
  const list = `<ul><li><a href="#um">Um</a></li><li><a href="#dois">Dois</a></li><li><a href="#tres">Três</a></li></ul>`;
  const body = `<h2><span class="ez-toc-section" id="um"></span>Um<span class="ez-toc-section-end"></span></h2><p>Texto.</p><h3>Dois</h3><p>Mais.</p>`;
  const clean = `<h2>Um</h2><p>Texto.</p><h3>Dois</h3><p>Mais.</p>`;

  test("Easy Table of Contents, com título e Toggle: sai o bloco e ficam os títulos do texto", () => {
    const p = prep(`<div id="ez-toc-container" class="ez-toc-v2_0_87 ez-toc-grey"><div class="ez-toc-title-container"><p class="ez-toc-title">Índice do Artigo</p><span class="ez-toc-title-toggle"><a href="#" class="ez-toc-toggle"><span class="eztoc-hide">Toggle</span></a></span></div><nav>${list}</nav></div>${body}`);
    assert.equal(p.tocsRemoved, 1);
    assert.equal(p.manualTocs, 0);
    assert.equal(finishHtml(p, () => null), clean);
  });

  for (const [name, open, close] of [
    ["sem Toggle", `<div id="ez-toc-container"><nav>`, `</nav></div>`],
    ["Rank Math, com título próprio", `<div class="wp-block-rank-math-toc-block" id="rank-math-toc"><h2>Índice</h2><nav>`, `</nav></div>`],
    ["Table of Contents Plus", `<div id="toc_container"><p class="toc_title">Contents</p>`, `</div>`],
    ["Yoast", `<div class="schema-faq wp-block-yoast-seo-table-of-contents yoast-table-of-contents"><h2>Sumário</h2>`, `</div>`],
    ["LuckyWP", `<div class="lwptoc lwptoc-light"><div>`, `</div></div>`],
  ] as const) {
    test(`variação: ${name}`, () => {
      const p = prep(`<p>Antes.</p>${open}${list}${close}${body}`);
      assert.equal(p.tocsRemoved, 1);
      assert.equal(finishHtml(p, () => null), `<p>Antes.</p>${clean}`);
    });
  }

  test("índice escrito à mão fica no texto e é contado", () => {
    const p = prep(`<p>Veja:</p>${list}${body}`);
    assert.equal(p.tocsRemoved, 0);
    assert.equal(p.manualTocs, 1);
    assert.match(finishHtml(p, () => null), /<li><a href="#um">Um<\/a><\/li>/);
  });

  test("lista comum não conta como índice; marca dentro do título não remove o título", () => {
    const p = prep(`<ul><li><a href="https://outro.com/a">a</a></li><li><a href="#b">b</a></li><li>c</li></ul>${body}`);
    assert.deepEqual([p.tocsRemoved, p.manualTocs], [0, 0]);
    assert.match(finishHtml(p, () => null), /<h2>Um<\/h2>/);
  });
});

describe("--drop-links com troca por áudio", () => {
  const url = "https://cdn.exemplo/stream/ep3.mp3";
  const make = () =>
    prepareHtml(`<h3>Baixe</h3><p><a href="http://antigo.com.br/errado.mp3">MP3</a></p>`, { base: "https://antigo.com.br", oldHosts: new Set(["antigo.com.br"]), postTitle: "T", resolveLink: () => null, replaceLink: (x) => (x === "/errado.mp3" ? url : null) });

  test("o link passa para o arquivo copiado", () => {
    const p = make();
    assert.deepEqual(p.audios, [url]);
    assert.equal(finishHtml(p, () => null, () => "/wp-content/uploads/2026/11/ep3.mp3"), `<h3>Baixe</h3><p><a href="/wp-content/uploads/2026/11/ep3.mp3">MP3</a></p>`);
  });

  test("se a cópia falhar, o link sai em vez de apontar para outro site", () => {
    assert.equal(finishHtml(make(), () => null, () => null), `<h3>Baixe</h3>`);
  });
});

describe("--drop-links", () => {
  const zip = "/wp-content/uploads/z.zip";
  const mp3 = "/wp-content/uploads/e2.mp3";
  const run = (html: string, drop: string[]) => {
    const p = prepareHtml(html, { base: "https://antigo.com.br", oldHosts: new Set(["antigo.com.br"]), postTitle: "T", resolveLink: () => null, dropLink: (x) => drop.includes(x) });
    return finishHtml(p, () => null, () => "/novo.mp3");
  };
  const link = (path: string, label: string) => `<p><a href="http://antigo.com.br${path}">${label}</a></p>`;

  test("sai o parágrafo do link; o título fica se ainda há conteúdo embaixo", () => {
    assert.equal(run(`<h3>Baixe</h3>${link(mp3, "MP3")}${link(zip, "Zip")}<p>Texto.</p>`, [zip]), `<h3>Baixe</h3><p><a href="/novo.mp3">MP3</a></p><p>Texto.</p>`);
  });

  test("sem nada embaixo do título, ele sai junto; título sem link removido fica", () => {
    assert.equal(run(`<h3>Baixe</h3>${link(mp3, "MP3")}${link(zip, "Zip")}<h3>Assine</h3><p>Feed.</p>`, [zip, mp3]), `<h3>Assine</h3><p>Feed.</p>`);
    assert.equal(run(`<h3>Sozinho</h3><h3>Outro</h3>`, [zip]), `<h3>Sozinho</h3><h3>Outro</h3>`);
  });

  test("link no meio do parágrafo sai e o texto fica", () => {
    assert.equal(run(`<p>Antes <a href="https://antigo.com.br${zip}">x</a> depois.</p>`, [zip]), `<p>Antes  depois.</p>`);
  });
});

describe("páginas importadas como post", () => {
  test("o parágrafo do convite do WhatsApp sai e os outros canais ficam", () => {
    const html = cleanPageHtml(
      `<p>Entre em um dos meus canais:</p>\n</p>\n<p>Canal no Telegram &#8211; <a href="https://t.me/canal">https://t.me/canal</a></p>\n<p>Grupo no Whatsapp &#8211; <a href="https://chat.whatsapp.com/Abc123" target="_blank">https://chat.whatsapp.com/Abc123</a></p>\n<p>Chatbots no Messenger e no Whatsapp.</p>\n<p>Grupo no Facebook &#8211; <a href="https://www.facebook.com/groups/x/">fb</a></p>`,
      "Outro título"
    );
    assert.doesNotMatch(html, /chat\.whatsapp|Grupo no Whatsapp/);
    assert.match(html, /t\.me\/canal/);
    assert.match(html, /Chatbots no Messenger e no Whatsapp/);
    assert.match(html, /facebook\.com\/groups/);
  });
});

describe("categorias", () => {
  const targets = [
    { id: 2, slug: "roteiros", name: "Roteiros" },
    { id: 3, slug: "dicas", name: "Dicas" },
  ];

  test("JSON, lista e texto dão as mesmas regras", () => {
    const expected = [{ from: "lugares", to: "roteiros" }, { from: "*", to: "dicas" }];
    assert.deepEqual(parseCategoryMap(`{"lugares": "roteiros", "*": "dicas"}`), expected);
    assert.deepEqual(parseCategoryMap(`[{"de": "lugares", "para": "roteiros"}, {"de": "*", "para": "dicas"}]`), expected);
    assert.deepEqual(parseCategoryMap(`# comentário\nlugares => roteiros\n* , dicas\n`), expected);
  });

  test("vale a primeira regra do arquivo; nome, slug ou id servem; '*' é o padrão; destino inexistente é problema", () => {
    const m = new CategoryMapper(parseCategoryMap(`Nova York => 2\nlugares => Dicas\nsumida => nao-existe\n* => dicas`), targets);
    assert.equal(m.problems.length, 1);
    const ny = { slug: "nova-york", name: "Nova York", path: "/category/lugares/nova-york/" };
    const lugares = { slug: "lugares", name: "Lugares", path: "/category/lugares/" };
    assert.equal(m.forPost([lugares, ny])?.slug, "roteiros");
    assert.equal(m.forPost([lugares])?.slug, "dicas");
    assert.equal(m.forPost([{ slug: "outra", name: "Outra", path: "/category/outra/" }])?.slug, "dicas");
    assert.equal(m.forCategory({ slug: "outra", name: "Outra", path: "" }), null, "o '*' não vale para redirect de categoria");
  });

  test("'-' = não importar: só ignora quem não tem outra categoria com regra; vale antes do '*'", () => {
    const m = new CategoryMapper(parseCategoryMap(`lugares => roteiros\ndemo => -\n* => dicas`), targets);
    assert.deepEqual(m.problems, []);
    const demo = { slug: "demo", name: "Demo", path: "/category/demo/" };
    const lugares = { slug: "lugares", name: "Lugares", path: "/category/lugares/" };
    const outra = { slug: "outra", name: "Outra", path: "/category/outra/" };
    assert.equal(m.skips([demo]), true);
    assert.equal(m.forPost([demo]), null);
    assert.equal(m.skips([demo, lugares]), false);
    assert.equal(m.forPost([demo, lugares])?.slug, "roteiros");
    // Categoria sem regra junto com uma marcada com "-": ignorado (o "-" vale antes do "*")
    assert.equal(m.skips([demo, outra]), true);
    assert.equal(m.forPost([outra])?.slug, "dicas");
    assert.equal(m.forCategory(demo), null, "categoria ignorada não ganha redirect");
    assert.equal(new CategoryMapper(parseCategoryMap(`* => -`), targets).problems.length, 1);
  });
});

describe("redirects", () => {
  test("bloco gerado: preserva o que está fora, acumula entre rodadas e não sobrepõe regra manual", () => {
    const manual = "# comentário\n/sobre-nos/ /sobre/\n";
    const r1 = mergeRedirects(manual, new Map([["/category/lugares/", "/category/roteiros/"], ["/sobre-nos/", "/x/"]]));
    assert.equal(r1.added, 1);
    assert.deepEqual(r1.skipped, ["/sobre-nos/ (já tem regra manual)"]);
    assert.equal(r1.content, `# comentário\n/sobre-nos/ /sobre/\n\n${BLOCK_START}\n/category/lugares/ /category/roteiros/\n${BLOCK_END}\n`);
    const r2 = mergeRedirects(r1.content, new Map([["/wp-content/uploads/2016/08/a.jpg", "/wp-content/uploads/2026/11/a.jpg"]]));
    assert.equal(r2.total, 2);
    assert.equal(mergeRedirects(r2.content, new Map([["/category/lugares/", "/category/roteiros/"]])).added, 0);
  });

  test("o arquivo gerado é aceito pelo servidor (api/static.ts)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "redirects-"));
    const file = path.join(dir, "redirects.txt");
    await writeFile(file, mergeRedirects("", new Map([["/post-velho/", "/post-novo/"], ["/categoria/x/", "/category/y/"]])).content);
    const map = loadRedirects(file);
    assert.equal(map.get("/post-velho/"), "/post-novo/");
    assert.equal(map.size, 2);
    await rm(dir, { recursive: true });
  });
});

describe("SEO", () => {
  test("tira o nome do site do <title> e expande variáveis do Yoast e do Rank Math", () => {
    assert.equal(stripSiteName("Guia de Wi-Fi - Asas do Mundo", "Asas do Mundo"), "Guia de Wi-Fi");
    assert.equal(stripSiteName("Guia | Asas do Mundo", "Asas do Mundo"), "Guia");
    assert.equal(expandSeoVars("%%title%% %%sep%% %%sitename%%", { title: "Post", siteName: "Site", excerpt: "" }), "Post - Site");
    assert.equal(expandSeoVars("%title% %page% %sep%", { title: "Post", siteName: "Site", excerpt: "" }), "Post");
  });
});

describe("XML de exportação (WXR)", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "wxr-"));
  });
  after(async () => rm(dir, { recursive: true, force: true }));

  test("lê posts publicados, categorias com pai, imagem destacada com alt e SEO do Yoast", async () => {
    const xml = `<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"><channel>
<title>Site Velho</title><link>https://antigo.com.br</link><wp:base_blog_url>https://antigo.com.br</wp:base_blog_url>
<wp:category><wp:term_id>1</wp:term_id><wp:category_nicename><![CDATA[lugares]]></wp:category_nicename><wp:category_parent><![CDATA[]]></wp:category_parent><wp:cat_name><![CDATA[Lugares]]></wp:cat_name></wp:category>
<wp:category><wp:term_id>2</wp:term_id><wp:category_nicename><![CDATA[nova-york]]></wp:category_nicename><wp:category_parent><![CDATA[lugares]]></wp:category_parent><wp:cat_name><![CDATA[Nova York]]></wp:cat_name></wp:category>
<item><title>Foto</title><wp:post_id>10</wp:post_id><wp:post_type><![CDATA[attachment]]></wp:post_type><wp:status><![CDATA[inherit]]></wp:status><wp:attachment_url><![CDATA[https://antigo.com.br/wp-content/uploads/2016/08/capa.jpg]]></wp:attachment_url>
<wp:postmeta><wp:meta_key><![CDATA[_wp_attachment_image_alt]]></wp:meta_key><wp:meta_value><![CDATA[Times Square à noite]]></wp:meta_value></wp:postmeta></item>
<item><title>Dicas &amp; truques</title><link>https://antigo.com.br/2016/08/dicas/</link><content:encoded><![CDATA[<!-- wp:paragraph --><p>Oi</p><!-- /wp:paragraph -->]]></content:encoded><excerpt:encoded><![CDATA[Resumo]]></excerpt:encoded>
<wp:post_id>11</wp:post_id><wp:post_date><![CDATA[2016-08-25 14:32:59]]></wp:post_date><wp:post_date_gmt><![CDATA[2016-08-25 17:32:59]]></wp:post_date_gmt><wp:post_name><![CDATA[dicas]]></wp:post_name><wp:status><![CDATA[publish]]></wp:status><wp:post_type><![CDATA[post]]></wp:post_type>
<category domain="category" nicename="nova-york"><![CDATA[Nova York]]></category><category domain="post_tag" nicename="x"><![CDATA[x]]></category>
<wp:postmeta><wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key><wp:meta_value><![CDATA[10]]></wp:meta_value></wp:postmeta>
<wp:postmeta><wp:meta_key><![CDATA[_yoast_wpseo_title]]></wp:meta_key><wp:meta_value><![CDATA[%%title%% em NY %%sep%% %%sitename%%]]></wp:meta_value></wp:postmeta>
<wp:postmeta><wp:meta_key><![CDATA[_yoast_wpseo_metadesc]]></wp:meta_key><wp:meta_value><![CDATA[Descrição do Yoast]]></wp:meta_value></wp:postmeta></item>
<item><title>Rascunho</title><wp:post_id>12</wp:post_id><wp:post_name>rascunho</wp:post_name><wp:status><![CDATA[draft]]></wp:status><wp:post_type><![CDATA[post]]></wp:post_type></item>
</channel></rss>`;
    const file = path.join(dir, "export.xml");
    await writeFile(file, xml);
    const site = await readXml(file, {});
    assert.equal(site.total, 1);
    const [p] = site.posts;
    assert.equal(p!.title, "Dicas & truques");
    assert.equal(p!.slug, "dicas");
    assert.equal(p!.dateGmt, "2016-08-25T17:32:59");
    assert.deepEqual(p!.categories, [{ slug: "nova-york", name: "Nova York", path: "/category/lugares/nova-york/" }]);
    assert.deepEqual(p!.featured, { url: "https://antigo.com.br/wp-content/uploads/2016/08/capa.jpg", alt: "Times Square à noite" });
    assert.equal(p!.seoTitle, "Dicas & truques em NY");
    assert.equal(p!.seoDescription, "Descrição do Yoast");
    assert.equal(site.allLinks.get("/2016/08/dicas/"), "dicas");
  });
});

describe("--suggest-categories", async () => {
  const { formatSuggestion, outputFile, postsPerTarget, similarity, suggestCategories } = await import("./suggest.ts");
  const targets = [
    { id: 2, slug: "renda-extra", name: "Renda extra", description: "Formas de ganhar dinheiro além do salário." },
    { id: 4, slug: "investimentos", name: "Investimentos", description: "Tesouro Direto, renda fixa, fundos e ações." },
    { id: 7, slug: "cartoes", name: "Cartões e bancos", description: "Contas digitais, cartões de crédito e tarifas." },
  ];
  const source = [
    { id: 10, name: "Investimento", slug: "investimento", count: 4, parent: 0 },
    { id: 11, name: "Tesouro", slug: "tesouro", count: 2, parent: 10 },
    { id: 12, name: "Cartão de Crédito", slug: "cartao-de-credito", count: 3, parent: 0 },
    { id: 13, name: "Ganhar Dinheiro", slug: "ganhar-dinheiro", count: 2, parent: 0 },
    { id: 14, name: "Receitas de bolo", slug: "receitas", count: 1, parent: 0 },
  ];
  const posts = [
    { title: "Como ganhar dinheiro além do salário", categories: [13] },
    { title: "Formas de ganhar renda em casa", categories: [13] },
    { title: "Tesouro Selic ou CDB?", categories: [10, 11] },
    { title: "Bolo de cenoura", categories: [14] },
  ];
  const list = suggestCategories(source, posts, targets);
  const pick = (slug: string) => list.find((s) => s.source.slug === slug)!;

  test("nome sem acento, plural e maiúsculas; filho herda do pai; títulos decidem; sem nada, '?'", () => {
    assert.ok(similarity("Cartões", "cartao") >= 0.8);
    assert.deepEqual([pick("investimento").target, pick("investimento").confidence], ["investimentos", "alta"]);
    assert.deepEqual([pick("tesouro").target, pick("tesouro").reason], ["investimentos", "pai"]);
    assert.equal(pick("cartao-de-credito").target, "cartoes");
    assert.deepEqual([pick("ganhar-dinheiro").target, pick("ganhar-dinheiro").reason], ["renda-extra", "palavras"]);
    assert.deepEqual([pick("receitas").target, pick("receitas").confidence], ["?", null]);
  });

  test("arquivo no formato do mapeamento: subcategoria antes, comentário com confiança e posts; '?' é lido", () => {
    const text = formatSuggestion(list, { from: "https://antigo.com.br", blog: "x" });
    const rules = parseCategoryMap(text);
    assert.deepEqual(rules[0], { from: "tesouro", to: "investimentos" });
    assert.ok(rules.some((r) => r.from === "receitas" && r.to === "?"));
    assert.match(text, /investimento => investimentos\s+# confiança alta \(pelo nome\), 4 post\(s\), "Investimento"/);
    assert.deepEqual(Object.fromEntries(postsPerTarget(list, posts, targets)), { "renda-extra": 2, investimentos: 1, "?": 1 });
  });

  test("não sobrescreve um mapeamento que já existe", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sugestao-"));
    const file = path.join(dir, "categorias.txt");
    assert.equal(outputFile(file), file);
    await writeFile(file, "a => b\n");
    assert.equal(outputFile(file), `${file}.sugerido`);
    await rm(dir, { recursive: true, force: true });
  });

  test("importação e --dry-run param enquanto houver '?'", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = await mkdtemp(path.join(os.tmpdir(), "sugestao-"));
    const file = path.join(dir, "categorias.txt");
    await writeFile(file, "receitas => ?  # confiança: ?\nlugares => roteiros\n");
    const r = spawnSync(process.execPath, ["scripts/import-wordpress/import.ts", "--xml", path.join(dir, "nao-existe.xml"), "--blog", "exemplo", "--categories", file, "--dry-run"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ainda tem "\?" em: receitas/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("regra de um post só (post:<slug>)", () => {
  const targets = [
    { id: 2, slug: "roteiros", name: "Roteiros" },
    { id: 3, slug: "dicas", name: "Dicas" },
  ];
  test("vence a regra por categoria, aceita slug com acento ou codificado, e destino inexistente é problema", () => {
    const m = new CategoryMapper(parseCategoryMap(`post:acoes-e-ações => roteiros\npost:fora => -\npost:sumida => nao-existe\nlugares => dicas`), targets);
    assert.equal(m.problems.length, 1);
    assert.equal((m.forSlug("acoes-e-a%C3%A7%C3%B5es") as { slug: string }).slug, "roteiros");
    assert.equal(m.forSlug("acoes-e-ações".normalize("NFD")) !== undefined, true);
    assert.equal(m.forSlug("fora"), "-");
    assert.equal(m.forSlug("outro"), undefined);
    assert.deepEqual(m.postRuleSlugs().sort(), ["acoes-e-ações", "fora"]);
    // A regra de post não muda as regras por categoria (nem os redirects de categoria)
    assert.equal(m.forPost([{ slug: "lugares", name: "Lugares", path: "" }])?.slug, "dicas");
  });
});

describe("regras manuais do redirects.txt", async () => {
  const { manualRedirects } = await import("./mapping.ts");
  test("só as de fora do bloco gerado, com o tipo (301 quando não diz)", () => {
    const text = `/a/ /b/\n/curto/ https://x.example 307\n# /comentada/ /x/\n\n${BLOCK_START}\n/gerada/ /y/\n${BLOCK_END}\n`;
    assert.deepEqual([...manualRedirects(text)], [["/a/", { to: "/b/", status: 301 }], ["/curto/", { to: "https://x.example", status: 307 }]]);
  });
});
