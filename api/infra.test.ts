import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import type { FastifyRequest } from "fastify";
import { hashPassword } from "./auth.ts";
import { runBackup } from "./backup.ts";
import { GlobalBuildLock } from "./build-lock.ts";
import { clientIp, isCloudflare } from "./client-ip.ts";
import { loadEnv, type ApiEnv } from "./env.ts";
import { precompress } from "./precompress.ts";
import { signV4 } from "./s3.ts";
import { nextRun } from "./scheduler.ts";
import { buildApp, type App } from "./server.ts";
import { loadRedirects } from "./static.ts";

let tmp: string;
let env: ApiEnv;
let ctx: App;

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "blog-infra-"));
  const release = path.join(tmp, "releases", "r1");
  await mkdir(path.join(release, "_astro"), { recursive: true });
  await mkdir(path.join(release, "um-post"), { recursive: true });
  await writeFile(path.join(release, "index.html"), "<h1>home</h1>");
  await writeFile(path.join(release, "404.html"), "<h1>nao encontrada</h1>");
  await writeFile(path.join(release, "um-post", "index.html"), "<h1>post</h1>".repeat(200));
  await writeFile(path.join(release, "_astro", "app.abc123.css"), "body{}");
  await writeFile(path.join(release, "sitemap.xml"), "<urlset/>");
  await precompress(release);
  await symlink(release, path.join(tmp, "current"));
  await mkdir(path.join(tmp, "uploads", "2026", "10"), { recursive: true });
  await writeFile(path.join(tmp, "uploads", "2026", "10", "foto.png"), "png");
  await writeFile(path.join(tmp, "uploads", "2026", "10", "foto.json"), "{}");

  env = loadEnv({
    user: "u",
    passwordHash: hashPassword("p"),
    contentDir: path.join(tmp, "content", "posts"),
    uploadsDir: path.join(tmp, "uploads"),
    stateFile: path.join(tmp, "data", "api-state.json"),
    backupDir: path.join(tmp, "backups"),
    currentLink: path.join(tmp, "current"),
    buildMode: "none",
    serveStatic: true,
  });
  ctx = await buildApp(env, { logger: false });
});

after(async () => {
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("site estático", () => {
  test("HTML sempre revalidado, com cabeçalhos de segurança", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "public, max-age=0, must-revalidate");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(String(res.headers["strict-transport-security"]), /max-age=31536000/);
  });

  test("diretório sem barra redireciona; com barra serve o index.html", async () => {
    const redirect = await ctx.app.inject({ method: "GET", url: "/um-post" });
    assert.equal(redirect.statusCode, 301);
    assert.equal(redirect.headers.location, "/um-post/");
    const page = await ctx.app.inject({ method: "GET", url: "/um-post/" });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /post/);
  });

  test("serve a versão brotli pré-comprimida quando o navegador aceita", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/um-post/", headers: { "accept-encoding": "br, gzip" } });
    assert.equal(res.headers["content-encoding"], "br");
    assert.equal(res.headers["cache-control"], "public, max-age=0, must-revalidate");
  });

  test("/_astro/ com cache de 1 ano; XML com 10 minutos", async () => {
    const css = await ctx.app.inject({ method: "GET", url: "/_astro/app.abc123.css" });
    assert.equal(css.headers["cache-control"], "public, max-age=31536000, immutable");
    const xml = await ctx.app.inject({ method: "GET", url: "/sitemap.xml" });
    assert.equal(xml.headers["cache-control"], "public, max-age=600");
  });

  test("página inexistente: 404 com o 404.html do site", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/nao-existe/" });
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /nao encontrada/);
  });

  test("link antigo do WordPress com data redireciona para o post, se ele existir", async () => {
    const ok = await ctx.app.inject({ method: "GET", url: "/2024/05/um-post/" });
    assert.equal(ok.statusCode, 301);
    assert.equal(ok.headers.location, "/um-post/");
    const missing = await ctx.app.inject({ method: "GET", url: "/2024/05/nao-existe/" });
    assert.equal(missing.statusCode, 404);
  });

  test("redirects.txt: linhas válidas viram 301; linha inválida dá erro claro", async () => {
    const f = path.join(tmp, "redirects.txt");
    await writeFile(f, "# comentário\n/antigo/ /um-post/\n/externo https://exemplo.com/x\n");
    const map = loadRedirects(f);
    assert.equal(map.get("/antigo/"), "/um-post/");
    assert.equal(map.get("/externo"), "https://exemplo.com/x");
    await writeFile(f, "sem-barra /x\n");
    assert.throws(() => loadRedirects(f), /linha inválida/);
  });

  test("/feed/ redireciona para /feed.xml", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/feed/" });
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers.location, "/feed.xml");
  });

  test("caminhos do WordPress e arquivos ocultos: 404", async () => {
    for (const url of ["/wp-admin/", "/wp-login.php", "/xmlrpc.php", "/.env", "/um-post/.git/config"]) {
      const res = await ctx.app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 404, url);
    }
  });

  test("uploads: arquivo na hora, cache de 1 ano; .json de metadados oculto", async () => {
    const img = await ctx.app.inject({ method: "GET", url: "/wp-content/uploads/2026/10/foto.png" });
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers["cache-control"], "public, max-age=31536000, immutable");
    const meta = await ctx.app.inject({ method: "GET", url: "/wp-content/uploads/2026/10/foto.json" });
    assert.equal(meta.statusCode, 404);
  });

  test("rota inexistente da API continua com erro no formato do WP", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/wp-json/wp/v2/tags" });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, "rest_no_route");
  });
});

describe("IP do visitante", () => {
  const req = (ip: string, headers: Record<string, string> = {}) => ({ ip, headers }) as unknown as FastifyRequest;

  test("reconhece faixas da Cloudflare", () => {
    assert.ok(isCloudflare("173.245.48.10"));
    assert.ok(isCloudflare("2606:4700::1"));
    assert.ok(!isCloudflare("203.0.113.5"));
  });

  test("CF-Connecting-IP só vale quando a conexão vem da Cloudflare", () => {
    assert.equal(clientIp(req("173.245.48.10", { "cf-connecting-ip": "198.51.100.7" })), "198.51.100.7");
    assert.equal(clientIp(req("203.0.113.5", { "cf-connecting-ip": "198.51.100.7" })), "203.0.113.5", "cabeçalho forjado é ignorado");
  });

  test("atrás do Traefik (1 proxy): IP do X-Forwarded-For, sem aceitar o que vem forjado mais à esquerda", async () => {
    const own = await buildApp({ ...env, serveStatic: false }, { logger: false });
    own.app.get("/_ip", async (r) => clientIp(r));
    const direct = await own.app.inject({ method: "GET", url: "/_ip", remoteAddress: "10.0.0.2", headers: { "x-forwarded-for": "1.1.1.1, 198.51.100.9" } });
    assert.equal(direct.body, "198.51.100.9");
    const viaCf = await own.app.inject({
      method: "GET",
      url: "/_ip",
      remoteAddress: "10.0.0.2",
      headers: { "x-forwarded-for": "6.6.6.6, 173.245.48.10", "cf-connecting-ip": "198.51.100.7" },
    });
    assert.equal(viaCf.body, "198.51.100.7");
    await own.app.close();
  });
});

describe("assinatura S3 (AWS SigV4)", () => {
  test("bate com o vetor oficial get-vanilla da AWS", () => {
    const auth = signV4({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      region: "us-east-1",
      service: "service",
      headers: { "X-Amz-Date": "20150830T123600Z" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKey: "AKIDEXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      amzDate: "20150830T123600Z",
    });
    assert.equal(
      auth,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
    );
  });
});

describe("agendador", () => {
  test("próxima execução no mesmo dia ou no dia seguinte (UTC)", () => {
    const from = new Date("2026-10-27T05:30:00Z");
    assert.equal(nextRun(7, 15, from).toISOString(), "2026-10-27T07:15:00.000Z");
    assert.equal(nextRun(4, 15, from).toISOString(), "2026-10-28T04:15:00.000Z");
  });

  test("o minuto vem do SITE: blogs diferentes, minutos (quase sempre) diferentes", () => {
    const minutes = ["exemplo", "asasdomundo", "receitas", "financas", "pets"].map((site) => {
      process.env.SITE = site;
      const m = loadEnv({ user: "u", passwordHash: "x" }).scheduleMinute;
      return m;
    });
    delete process.env.SITE;
    assert.ok(minutes.every((m) => m >= 0 && m < 60));
    assert.ok(new Set(minutes).size >= 4);
  });
});

describe("backup", () => {
  test("gera .tar.gz com content/, uploads/ e data/", async () => {
    await mkdir(env.contentDir, { recursive: true });
    await writeFile(path.join(env.contentDir, "post.md"), "---\ntitle: x\n---\n");
    await mkdir(path.dirname(env.stateFile), { recursive: true });
    await writeFile(env.stateFile, "{}");
    const r = await runBackup(env);
    assert.ok(existsSync(r.file));
    assert.equal(r.uploaded, false);
    const list = execFileSync("tar", ["-tzf", r.file]).toString();
    assert.match(list, /content\/post\.md/);
    assert.match(list, /uploads\/2026\/10\/foto\.png/);
    assert.match(list, /data\/api-state\.json/);
  });
});

describe("pré-compressão", () => {
  test("só arquivos de texto maiores que 1 KB", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "blog-pc-"));
    await writeFile(path.join(dir, "grande.html"), "x".repeat(5000));
    await writeFile(path.join(dir, "pequeno.html"), "x");
    await writeFile(path.join(dir, "img.png"), Buffer.alloc(5000));
    const n = await precompress(dir);
    assert.equal(n, 1);
    assert.ok(existsSync(path.join(dir, "grande.html.br")) && existsSync(path.join(dir, "grande.html.gz")));
    assert.ok(!existsSync(path.join(dir, "img.png.br")));
    assert.ok(brotliCompressSync("x").length > 0);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("trava global de build", () => {
  test("no máximo N vagas; liberar abre espaço", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "blog-lock-"));
    const lock = (owner: string) => new GlobalBuildLock({ dir, slots: 2, owner, heartbeatMs: 50 });
    const a = await lock("a").tryAcquire();
    const b = await lock("b").tryAcquire();
    const c = await lock("c").tryAcquire();
    assert.ok(a && b);
    assert.equal(c, null, "terceiro container fica sem vaga");
    await a!.release();
    const d = await lock("d").tryAcquire();
    assert.ok(d, "a vaga liberada é reaproveitada");
    await b!.release();
    await d!.release();
    await rm(dir, { recursive: true, force: true });
  });

  test("vaga sem heartbeat além do prazo é retomada (container morto não trava os outros)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "blog-lock-"));
    await writeFile(path.join(dir, "slot-0.lock"), JSON.stringify({ token: "morto" }));
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(path.join(dir, "slot-0.lock"), old, old);
    const s = await new GlobalBuildLock({ dir, slots: 1, owner: "x" }).tryAcquire();
    assert.ok(s, "retomou a vaga abandonada");
    assert.equal(s!.slot, 0);
    await s!.release();
    assert.ok(!existsSync(path.join(dir, "slot-0.lock")));
    await rm(dir, { recursive: true, force: true });
  });

  test("vaga recente de outro container é respeitada; acquire espera e entra quando liberar", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "blog-lock-"));
    const holder = await new GlobalBuildLock({ dir, slots: 1, owner: "a" }).tryAcquire();
    let waited = 0;
    const waiter = new GlobalBuildLock({ dir, slots: 1, owner: "b", retryBaseMs: 20, retryJitterMs: 20, onWait: () => waited++ });
    const pending = waiter.acquire();
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(waited >= 2, "ficou esperando");
    await holder!.release();
    const s = await pending;
    assert.ok(s);
    await s.release();
    await rm(dir, { recursive: true, force: true });
  });
});
