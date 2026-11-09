/**
 * Interface do /admin: um modal só (modal.js) no lugar de confirm(), alert() e prompt() do navegador,
 * com a cor, a fonte e o logotipo do blog; textos em português.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-admin-ui-"));
process.env.SITE = "exemplo";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
process.env.ADMIN_USER = "chefe";

const { hashPassword } = await import("./auth.ts");
process.env.ADMIN_PASSWORD_HASH = hashPassword("senha do painel");
const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");
const { default: site } = await import("../site.config.ts");
type Ctx = Awaited<ReturnType<typeof buildApp>>;

let ctx: Ctx;
let cookie = "";
const UI = path.resolve("api/admin-ui");
const read = (f: string) => readFileSync(path.join(UI, f), "utf8");
/** Chamada solta de diálogo do navegador (Modal.confirm não conta). */
const NATIVE = /(^|[^.\w])(confirm|alert|prompt)\(/m;

before(async () => {
  ctx = await buildApp(
    loadEnv({ contentDir: path.join(tmp, "posts"), uploadsDir: path.join(tmp, "uploads"), stateFile: path.join(tmp, "state.json"), secretsFile: path.join(tmp, "secrets.json"), buildMode: "none", serveStatic: false, scheduler: false, currentLink: path.join(tmp, "current") }),
    { logger: false }
  );
  const res = await ctx.app.inject({ method: "POST", url: "/admin/api/login", payload: { user: "chefe", password: "senha do painel" } });
  cookie = String(res.headers["set-cookie"]).split(";")[0]!;
});

after(async () => {
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("modal do painel", () => {
  test("nenhum confirm(), alert() ou prompt() nativo nos scripts do painel e do assistente", () => {
    for (const f of ["admin.js", "setup.js"]) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.doesNotMatch(code, NATIVE, f);
    }
  });

  test("modal.js é servido e carregado antes do admin.js", async () => {
    const res = await ctx.app.inject({ url: "/admin/ui/modal.js" });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /javascript/);
    const html = read("admin.html");
    assert.ok(html.indexOf("/admin/ui/modal.js") > 0 && html.indexOf("/admin/ui/modal.js") < html.indexOf("/admin/ui/admin.js"));
  });

  test("acessibilidade e textos: role, aria-modal, Esc, Enter, foco preso, Cancelar", () => {
    const m = read("modal.js");
    for (const needle of ['"aria-modal", "true"', '"role"', "aria-labelledby", "aria-describedby", '"Escape"', '"Enter"', '"Tab"', 'cancelar: "Cancelar"', ".inert = true"]) assert.ok(m.includes(needle), needle);
  });

  test("ações perigosas têm botão em destaque com o nome da ação", () => {
    const js = read("admin.js");
    for (const label of ['"Excluir categoria"', '"Excluir artigo"', '"Remover foto"', '"Apagar e reiniciar"', '"Gerar nova senha"']) {
      assert.ok(js.includes(`confirmLabel: ${label}, danger: true`) || js.includes(label), label);
    }
    assert.match(js, /const label = list\.length === 1 \? "Excluir artigo"/);
    assert.equal((js.match(/danger: true/g) ?? []).length, 5);
  });

  test("o estado traz cor, fonte e logotipo do blog para o modal", async () => {
    const s = (await ctx.app.inject({ url: "/admin/api/state", headers: { cookie } })).json();
    assert.equal(s.fontFamily, site.theme.fontFamily);
    assert.ok(s.colors.primary && s.logo);
    assert.match(read("admin.js"), /Modal\.setTheme\(\{ primary: state\.colors\.primary, fontFamily: state\.fontFamily, logo: state\.logo \}\)/);
  });
});

describe("textos em português", () => {
  test("a tela da home se chama Página inicial (o endereço /admin/home continua)", async () => {
    assert.match(read("admin.js"), /\["home", "Página inicial"\]/);
    assert.match(read("admin.html"), /data-tab="Página inicial"/);
    assert.doesNotMatch(read("setup.html"), /aba Home/);
    assert.equal((await ctx.app.inject({ url: "/admin/home" })).statusCode, 200);
  });
});
