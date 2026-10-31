import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Writable } from "node:stream";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-login-"));
process.env.SITE = "exemplo";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
const { Authenticator, cleanEnvValue, hashPassword, isValidHash, verifyPassword } = await import("./auth.ts");
const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");

/** O hash vem do próprio script, como em produção. */
function scriptHash(password: string): string {
  const out = execFileSync(process.execPath, ["scripts/hash-admin-password.ts", password], { encoding: "utf8" });
  return out.match(/^ADMIN_PASSWORD_HASH=(.+)$/m)![1]!;
}

let n = 0;
async function server(vars: { user?: string; hash?: string; trustProxyHops?: number; secrets?: object }) {
  const dir = path.join(tmp, `s${n++}`);
  if (vars.user === undefined) delete process.env.ADMIN_USER;
  else process.env.ADMIN_USER = vars.user;
  if (vars.hash === undefined) delete process.env.ADMIN_PASSWORD_HASH;
  else process.env.ADMIN_PASSWORD_HASH = vars.hash;
  const secretsFile = `${dir}-secrets.json`;
  if (vars.secrets) await writeFile(secretsFile, JSON.stringify(vars.secrets));
  return buildApp(
    loadEnv({
      user: "wordbee",
      passwordHash: hashPassword("outra"),
      contentDir: path.join(dir, "posts"),
      uploadsDir: path.join(dir, "uploads"),
      stateFile: path.join(dir, "state.json"),
      secretsFile,
      buildMode: "none",
      serveStatic: false,
      trustProxyHops: vars.trustProxyHops ?? 0,
    }),
    { logger: false }
  );
}
type Ctx = Awaited<ReturnType<typeof buildApp>>;
const login = (ctx: Ctx, user: string, password: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: "POST", url: "/admin/api/login", headers, payload: { user, password } });

/** Login completo: o cookie devolvido precisa abrir o painel. */
async function assertFullLogin(ctx: Ctx, user: string, password: string) {
  const res = await login(ctx, user, password);
  assert.equal(res.statusCode, 200, `${user}: ${res.body}`);
  const state = await ctx.app.inject({ url: "/admin/api/state", headers: { cookie: String(res.headers["set-cookie"]).split(";")[0]! } });
  assert.equal(state.statusCode, 200);
}

after(async () => {
  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASSWORD_HASH;
  await rm(tmp, { recursive: true, force: true });
});

describe("login do /admin com hash gerado pelo script", () => {
  const passwords = ["S3nh@+f0rte%&=/", "a+b+c+d+e+f", 'aspas"e\'símbolos#$!?\\', "çãé+Ação 100%", "=====+====="];
  for (const password of passwords) {
    test(`senha ${JSON.stringify(password)}`, async () => {
      const ctx = await server({ user: "rafael", hash: scriptHash(password) });
      await assertFullLogin(ctx, "rafael", password);
      assert.equal((await login(ctx, "rafael", password + "x")).statusCode, 401);
      await ctx.app.close();
    });
  }

  test("corpo em bytes reais do navegador (JSON com + e %)", async () => {
    const password = "a+b%20c&d=e";
    const ctx = await server({ user: "rafael", hash: scriptHash(password) });
    const res = await ctx.app.inject({ method: "POST", url: "/admin/api/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ user: "rafael", password }) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await login(ctx, "rafael", "a b%20c&d=e")).statusCode, 401, '"+" não vira espaço');
    await ctx.app.close();
  });
});

describe("a causa do erro: valores que chegam diferentes", () => {
  const password = "S3nh@+f0rte%&=/";
  const hash = scriptHash(password);
  const cases: [string, string, string][] = [
    ["aspas duplas nas duas variáveis", '"rafael"', `"${hash}"`],
    ["aspas simples nas duas variáveis", "'rafael'", `'${hash}'`],
    ["aspas só no usuário", '"rafael"', hash],
    ["aspas só no hash", "rafael", `"${hash}"`],
    ["espaço e quebra de linha nas pontas", " rafael ", `${hash}\n`],
  ];
  for (const [name, user, value] of cases) {
    test(name, async () => {
      const ctx = await server({ user, hash: value });
      await assertFullLogin(ctx, "rafael", password);
      await ctx.app.close();
    });
  }

  test("celular: maiúscula automática e espaço depois do usuário", async () => {
    const ctx = await server({ user: "rafael", hash });
    await assertFullLogin(ctx, "Rafael", password);
    await assertFullLogin(ctx, "rafael ", password);
    await ctx.app.close();
  });

  test("usuário realmente diferente continua recusado", async () => {
    const ctx = await server({ user: "rafael", hash });
    assert.equal((await login(ctx, "rafaela", password)).statusCode, 401);
    await ctx.app.close();
  });

  test("cleanEnvValue não mexe no interior nem em aspa sem par", () => {
    assert.equal(cleanEnvValue('  "a b"  '), "a b");
    assert.equal(cleanEnvValue('a"b'), 'a"b');
    assert.equal(cleanEnvValue('"ab'), '"ab');
    assert.equal(cleanEnvValue(undefined), "");
    assert.equal(cleanEnvValue('""'), "");
  });

  test("hash inválido não derruba o servidor", () => {
    for (const bad of ["", "abc", "scrypt:1:2", "scrypt:15:8:1:c2FsdA==:a2V5", "md5:1:1:1:a:b"]) assert.equal(verifyPassword("x", bad), false, bad);
    assert.equal(isValidHash(hash), true);
    assert.equal(isValidHash("abc"), false);
    assert.equal(verifyPassword("o mesmo ç", hashPassword("o mesmo ç")), true, "NFC e NFD valem a mesma senha");
  });
});

describe("de onde vêm as credenciais", () => {
  const password = "senha-nova-1234";
  const stale = { adminUser: "antigo", adminPasswordHash: hashPassword("senha-antiga-1234") };

  test("variáveis ADMIN_* têm prioridade sobre um secrets.json antigo", async () => {
    const ctx = await server({ user: "rafael", hash: scriptHash(password), secrets: stale });
    await assertFullLogin(ctx, "rafael", password);
    assert.equal((await login(ctx, "antigo", "senha-antiga-1234")).statusCode, 401);
    await ctx.app.close();
  });

  test("sem as variáveis, vale o secrets.json", async () => {
    const ctx = await server({ secrets: stale });
    await assertFullLogin(ctx, "antigo", "senha-antiga-1234");
    await ctx.app.close();
  });
});

describe("limite de tentativas", () => {
  const password = "S3nh@+f0rte%&=/";

  test("erros de um visitante não bloqueiam outro atrás do proxy", async () => {
    const ctx = await server({ user: "rafael", hash: scriptHash(password), trustProxyHops: 1 });
    const from = (ip: string) => ({ "x-forwarded-for": ip });
    for (let i = 0; i < 5; i++) assert.equal((await login(ctx, "rafael", "errada", from("203.0.113.1"))).statusCode, 401);
    assert.equal((await login(ctx, "rafael", password, from("203.0.113.1"))).statusCode, 429, "esse IP está bloqueado");
    assert.equal((await login(ctx, "rafael", password, from("203.0.113.2"))).statusCode, 200, "outro IP entra");
    await ctx.app.close();
  });

  test("login correto zera a contagem", async () => {
    const ctx = await server({ user: "rafael", hash: scriptHash(password) });
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) assert.equal((await login(ctx, "rafael", "errada")).statusCode, 401);
      assert.equal((await login(ctx, "rafael", password)).statusCode, 200);
    }
    await ctx.app.close();
  });

  test("o bloqueio expira", async () => {
    const auth = new Authenticator(() => ({ user: "u", passwordHash: hashPassword("certa") }), 1, 40);
    assert.throws(() => auth.checkPassword("u", "errada", "1.1.1.1"), { status: 401 });
    assert.throws(() => auth.checkPassword("u", "certa", "1.1.1.1"), { status: 429 });
    await new Promise((r) => setTimeout(r, 60));
    auth.checkPassword("u", "certa", "1.1.1.1");
  });
});

describe("diagnóstico no log", () => {
  const password = "S3nh@+f0rte%&=/";
  const hash = scriptHash(password);
  const captured: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { captured.push(String(chunk)); cb(); } });
  let original: typeof process.stdout.write;

  before(() => {
    original = process.stdout.write;
    process.stdout.write = ((c: unknown, ...rest: unknown[]) => {
      stream.write(String(c));
      const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
      cb?.();
      return true;
    }) as typeof process.stdout.write;
  });
  after(() => {
    process.stdout.write = original;
  });

  test("diz o motivo, sem senha nem hash", async () => {
    const dir = path.join(tmp, "log");
    process.env.ADMIN_USER = "rafael";
    process.env.ADMIN_PASSWORD_HASH = hash;
    const env = loadEnv({ user: "wordbee", passwordHash: hashPassword("x"), contentDir: path.join(dir, "p"), uploadsDir: path.join(dir, "u"), stateFile: path.join(dir, "s.json"), secretsFile: path.join(dir, "x.json"), buildMode: "none", serveStatic: false });
    const ctx = await buildApp(env);
    await login(ctx, "outro", password);
    await login(ctx, "rafael", "senha-errada-secreta");
    for (let i = 0; i < 4; i++) await login(ctx, "rafael", "senha-errada-secreta");
    await ctx.app.close();
    await new Promise((r) => setTimeout(r, 20));
    const all = captured.join("");
    assert.match(all, /usuário não confere/);
    assert.match(all, /senha não confere/);
    assert.match(all, /bloqueado por tentativas/);
    for (const secret of [password, "senha-errada-secreta", hash, hash.split(":").at(-1)!]) assert.ok(!all.includes(secret), "não vaza segredo");
  });

  test("hash inválido é nomeado no aviso e na recusa", async () => {
    captured.length = 0;
    const dir = path.join(tmp, "log2");
    process.env.ADMIN_USER = "rafael";
    process.env.ADMIN_PASSWORD_HASH = "scrypt:cortado";
    const env = loadEnv({ user: "wordbee", passwordHash: hashPassword("x"), contentDir: path.join(dir, "p"), uploadsDir: path.join(dir, "u"), stateFile: path.join(dir, "s.json"), secretsFile: path.join(dir, "x.json"), buildMode: "none", serveStatic: false });
    const ctx = await buildApp(env);
    assert.equal((await login(ctx, "rafael", password)).statusCode, 401);
    await ctx.app.close();
    await new Promise((r) => setTimeout(r, 20));
    const all = captured.join("");
    assert.match(all, /ADMIN_PASSWORD_HASH está em formato inválido/);
    assert.match(all, /hash inválido/);
    assert.ok(!all.includes("scrypt:cortado"));
  });
});
