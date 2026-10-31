import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-setup-"));
const KEY = "sk-ant-chave-secreta-de-teste";
const TOKEN = "codigo-de-setup";

process.env.SITE = "";
process.env.SITE_URL = "https://novo.example";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
delete process.env.AI_MODEL;
delete process.env.WP_USER;
delete process.env.WP_APP_PASSWORD_HASH;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASSWORD_HASH;

const GOOD = {
  categories: ["Um", "Dois", "Três", "Quatro", "Cinco"].map((name, i) => ({ name, slug: `cat-${i + 1}`, description: `Descrição ${name}.` })),
  authorName: "Equipe Horta",
  authorBio: "Quem escreve sobre hortas.",
  about: "Um blog sobre hortas em casa.",
  tagline: "Sua horta em casa",
  // Amarelo claro: precisa ser escurecido
  palette: { primary: "#ffee00", highlight: "#116633", callout: "#114411" },
};
const responses: { status: number; body: unknown }[] = [];
const requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
const textMessage = (text: string, stop = "end_turn") => ({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });
let ai: Server;

const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");
const { default: site } = await import("../site.config.ts");
let ctx: Awaited<ReturnType<typeof buildApp>>;

const setup = (url: string, payload: object, token = TOKEN) =>
  ctx.app.inject({ method: "POST", url: `/admin/setup/api/${url}`, headers: { "x-setup-token": token }, payload });
const generateBody = { name: "Horta em Casa", niche: "hortas urbanas", lang: "pt-BR" };

before(async () => {
  ai = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) });
      const next = responses.shift() ?? { status: 500, body: { type: "error", error: { type: "api_error", message: "sem resposta" } } };
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((r) => ai.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(ai.address() as AddressInfo).port}`;
  const env = loadEnv({
    contentDir: path.join(tmp, "posts"),
    uploadsDir: path.join(tmp, "uploads"),
    stateFile: path.join(tmp, "state.json"),
    buildMode: "none",
    serveStatic: true,
    currentLink: path.join(tmp, "current"),
    setupToken: TOKEN,
    anthropicApiKey: KEY,
  });
  ctx = await buildApp(env, { logger: false });
});

after(async () => {
  await ctx.app.close();
  ai.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("blog não configurado", () => {
  test("/ mostra Em configuração (noindex) e /health responde", async () => {
    const home = await ctx.app.inject({ url: "/" });
    assert.equal(home.statusCode, 503);
    assert.match(home.body, /Em configuração/);
    assert.match(home.body, /noindex/);
    assert.match(String(home.headers["x-robots-tag"]), /noindex/);
    const health = await ctx.app.inject({ url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().configured, false);
  });

  test("os 4 endpoints do Wordbee respondem 503", async () => {
    for (const [method, url] of [["GET", "users/me"], ["GET", "categories"], ["POST", "media"], ["POST", "posts"]] as const) {
      const res = await ctx.app.inject({ method, url: `/wp-json/wp/v2/${url}`, headers: { "content-type": method === "POST" ? "application/json" : "text/plain" }, ...(method === "POST" ? { payload: {} } : {}) });
      assert.equal(res.statusCode, 503, url);
      assert.deepEqual(Object.keys(res.json()).sort(), ["code", "data", "message"]);
    }
  });

  test("código errado: 401; depois de 5 erros, 429", async () => {
    const attempt = () => ctx.app.inject({ method: "POST", url: "/admin/setup/api/check", remoteAddress: "10.1.1.1", headers: { "x-setup-token": "errado" }, payload: {} });
    for (let i = 0; i < 5; i++) assert.equal((await attempt()).statusCode, 401);
    assert.equal((await attempt()).statusCode, 429);
  });
});

describe("geração com IA", () => {
  test("chave recusada: mensagem clara, sem a chave", async () => {
    responses.push({ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } });
    const res = await setup("generate", generateBody);
    assert.equal(res.statusCode, 502);
    assert.match(res.json().message, /chave/i);
    assert.ok(!res.body.includes(KEY));
  });

  test("resposta inválida é pedida de novo; duas vezes inválida vira erro para tentar de novo", async () => {
    responses.push({ status: 200, body: textMessage(JSON.stringify({ ...GOOD, categories: GOOD.categories.slice(0, 2) })) }, { status: 200, body: textMessage("não é json") });
    const res = await setup("generate", generateBody);
    assert.equal(res.statusCode, 502);
    assert.match(res.json().message, /tentar de novo/i);
  });

  test("recusa da IA vira mensagem clara", async () => {
    responses.push({ status: 200, body: textMessage("", "refusal") });
    const res = await setup("generate", generateBody);
    assert.equal(res.statusCode, 502);
    assert.match(res.json().message, /Reformule/);
  });

  test("descrição longa ou slug com acento não passam", async () => {
    const bad = { ...GOOD, categories: GOOD.categories.map((c, i) => (i === 0 ? { ...c, slug: "ação", description: "x".repeat(161) } : c)) };
    responses.push({ status: 200, body: textMessage(JSON.stringify(bad)) }, { status: 200, body: textMessage(JSON.stringify(GOOD)) });
    const res = await setup("generate", generateBody);
    assert.equal(res.statusCode, 200, res.body);
    const secondTry = JSON.stringify(requests.at(-1)!.body.messages);
    assert.match(secondTry, /recusada/);
  });

  test("sucesso: pede JSON pelo modelo configurado e corrige o contraste da paleta", async () => {
    responses.push({ status: 200, body: textMessage(JSON.stringify(GOOD)) });
    const res = await setup("generate", generateBody);
    assert.equal(res.statusCode, 200, res.body);
    const sent = requests.at(-1)!;
    assert.equal(sent.body.model, "claude-sonnet-5-5", "modelo padrão");
    assert.equal(sent.body.fallbacks, "default");
    assert.match(String(sent.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    assert.equal((sent.body.output_config as { format: { type: string } }).format.type, "json_schema");
    assert.notEqual(res.json().palette.primary, "#ffee00");
  });
});

describe("publicar", () => {
  let password = "";

  test("senha fraca é recusada e nada é gravado", async () => {
    const res = await setup("publish", { name: "Horta em Casa", adminPassword: "curta", proposal: GOOD });
    assert.equal(res.statusCode, 400);
    assert.ok(!existsSync(process.env.SETTINGS_FILE!));
  });

  test("grava configurações, ids estáveis, Sobre e secrets 600; mostra a senha", async () => {
    const res = await setup("publish", { name: "Horta em Casa", lang: "pt-BR", adminPassword: "senha-do-painel", proposal: { ...GOOD, palette: { ...GOOD.palette } } });
    assert.equal(res.statusCode, 200, res.body);
    password = res.json().wordbee.password;
    assert.equal(res.json().wordbee.user, "wordbee");

    const saved = JSON.parse(readFileSync(process.env.SETTINGS_FILE!, "utf8"));
    assert.equal(saved.configured, true);
    assert.deepEqual(saved.categories.map((c: { id: number }) => c.id), [2, 3, 4, 5, 6]);
    assert.equal(saved.nextCategoryId, 7);
    assert.equal(site.name, "Horta em Casa");
    assert.equal(site.contact.email, "contato@novo.example");
    assert.equal(site.authors[site.defaultAuthor]!.name, "Equipe Horta");

    const secretsFile = path.join(tmp, "secrets.json");
    assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
    const secrets = readFileSync(secretsFile, "utf8");
    assert.ok(!secrets.includes(password) && !secrets.includes(password.replace(/\s/g, "")), "só o hash");
    assert.ok(!secrets.includes("senha-do-painel"));
    assert.ok(!readFileSync(process.env.SETTINGS_FILE!, "utf8").includes(KEY));

    assert.match(readFileSync(path.join(tmp, "pages", "sobre.md"), "utf8"), /Um blog sobre hortas/);
    assert.ok(existsSync(path.join(tmp, "pages", "contato.md")));
    assert.ok(existsSync(path.join(tmp, "assets", "brand", "logo.svg")));
  });

  test("o assistente some e o Wordbee entra com a senha mostrada", async () => {
    assert.equal((await ctx.app.inject({ url: "/admin/setup" })).statusCode, 404);
    assert.equal((await setup("publish", {})).statusCode, 404);
    const auth = { authorization: "Basic " + Buffer.from(`wordbee:${password}`).toString("base64") };
    assert.equal((await ctx.app.inject({ url: "/wp-json/wp/v2/users/me", headers: auth })).statusCode, 200);
    const cats = await ctx.app.inject({ url: "/wp-json/wp/v2/categories", headers: auth });
    assert.deepEqual(cats.json().map((c: { id: number }) => c.id).sort(), [2, 3, 4, 5, 6]);
  });

  test("gerar nova senha no /admin invalida a anterior", async () => {
    const login = await ctx.app.inject({ method: "POST", url: "/admin/api/login", payload: { user: "admin", password: "senha-do-painel" } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const res = await ctx.app.inject({ method: "POST", url: "/admin/api/wordbee-password", headers: { cookie }, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    const check = (p: string) => ctx.app.inject({ url: "/wp-json/wp/v2/users/me", headers: { authorization: "Basic " + Buffer.from(`wordbee:${p}`).toString("base64") } });
    assert.equal((await check(password)).statusCode, 401);
    assert.equal((await check(res.json().password)).statusCode, 200);
  });
});

describe("sem ANTHROPIC_API_KEY", () => {
  test("o assistente avisa e não tenta gerar", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "blog-setup-nokey-"));
    process.env.SETTINGS_FILE = path.join(dir, "settings.json");
    const app = await buildApp(loadEnv({ contentDir: path.join(dir, "posts"), uploadsDir: path.join(dir, "u"), stateFile: path.join(dir, "s.json"), secretsFile: path.join(dir, "x.json"), buildMode: "none", serveStatic: false, setupToken: TOKEN, anthropicApiKey: "" }), { logger: false });
    const headers = { "x-setup-token": TOKEN };
    const check = await app.app.inject({ method: "POST", url: "/admin/setup/api/check", headers, payload: {} });
    assert.equal(check.json().aiConfigured, false);
    const gen = await app.app.inject({ method: "POST", url: "/admin/setup/api/generate", headers, payload: generateBody });
    assert.equal(gen.statusCode, 503);
    assert.match(gen.json().message, /ANTHROPIC_API_KEY/);
    await app.app.close();
    await rm(dir, { recursive: true, force: true });
    process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
  });
});

describe("setup desligado", () => {
  test("sem SETUP_TOKEN o assistente fica indisponível", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "blog-setup-off-"));
    process.env.SETTINGS_FILE = path.join(dir, "settings.json");
    const off = await buildApp(loadEnv({ contentDir: path.join(dir, "posts"), uploadsDir: path.join(dir, "u"), stateFile: path.join(dir, "s.json"), secretsFile: path.join(dir, "x.json"), buildMode: "none", serveStatic: false, setupToken: "" }), { logger: false });
    assert.equal((await off.app.inject({ url: "/admin/setup" })).statusCode, 404);
    await off.app.close();
    await rm(dir, { recursive: true, force: true });
    process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
  });
});
