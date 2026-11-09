/**
 * Áudio enviado pelo importador do WordPress: limite próprio (maior que o de imagem), gravado como veio
 * e entregue com Range (206), que o player do navegador usa para avançar no episódio.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-audio-"));
process.env.SITE = "exemplo";
process.env.SITE_URL = "https://blog.example";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
process.env.ASSETS_DIR = path.join(tmp, "assets");
const { hashPassword } = await import("./auth.ts");
const { loadEnv } = await import("./env.ts");
const { buildApp } = await import("./server.ts");

let ctx: Awaited<ReturnType<typeof buildApp>>;
const AUTH = { authorization: "Basic " + Buffer.from("wordbee:senha").toString("base64") };
const upload = (payload: Buffer, type = "audio/mpeg", name = "episodio.mp3") =>
  ctx.app.inject({ method: "POST", url: "/wp-json/wp/v2/media", headers: { ...AUTH, "content-type": type, "content-disposition": `attachment; filename="${name}"` }, payload });

before(async () => {
  ctx = await buildApp(
    loadEnv({
      user: "wordbee",
      passwordHash: hashPassword("senha"),
      contentDir: path.join(tmp, "posts"),
      uploadsDir: path.join(tmp, "uploads"),
      stateFile: path.join(tmp, "state.json"),
      secretsFile: path.join(tmp, "secrets.json"),
      currentLink: path.join(tmp, "current"),
      buildMode: "none",
      serveStatic: true,
      scheduler: false,
      rateLimitPerMinute: 10_000,
      maxUploadBytes: 1024 * 1024,
      maxAudioUploadBytes: 3 * 1024 * 1024,
    }),
    { logger: false }
  );
});
after(async () => {
  await ctx.app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("áudio em /wp-json/wp/v2/media", () => {
  const data = Buffer.from(Array.from({ length: 2 * 1024 * 1024 }, (_, i) => i % 251));
  let src = "";

  test("acima do limite de imagem e abaixo do de áudio: grava o arquivo como veio", async () => {
    const res = await upload(data);
    assert.equal(res.statusCode, 201, res.body);
    src = new URL(res.json().source_url).pathname;
    assert.match(src, /^\/wp-content\/uploads\/\d{4}\/\d{2}\/episodio\.mp3$/);
    assert.deepEqual(readFileSync(path.join(tmp, "uploads", src.slice("/wp-content/uploads/".length))), data);
    assert.equal(res.json().mime_type, "audio/mpeg");
  });

  test("o mesmo arquivo enviado de novo devolve o já gravado", async () => {
    const res = await upload(data);
    assert.equal(res.statusCode, 200);
    assert.equal(new URL(res.json().source_url).pathname, src);
  });

  test("acima do limite de áudio dá 413", async () => {
    const res = await upload(Buffer.alloc(4 * 1024 * 1024));
    assert.equal(res.statusCode, 413);
    assert.match(res.json().message, /3 MB/);
  });

  test("imagem continua com o limite dela", async () => {
    const res = await upload(Buffer.alloc(2 * 1024 * 1024), "image/png", "foto.png");
    assert.equal(res.statusCode, 413);
    assert.match(res.json().message, /1 MB/);
  });

  test("a extensão vem do tipo, não do nome enviado", async () => {
    const res = await upload(Buffer.from("outro"), "audio/mpeg", "pagina.html");
    assert.equal(res.statusCode, 201, res.body);
    const saved = new URL(res.json().source_url).pathname;
    assert.ok(saved.endsWith(".mp3"), saved);
    assert.ok(existsSync(path.join(tmp, "uploads", saved.slice("/wp-content/uploads/".length))));
  });

  test("o servidor entrega com Range: 206, bytes certos e sem recomprimir", async () => {
    const whole = await ctx.app.inject({ url: src });
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers["content-type"], "audio/mpeg");
    assert.equal(whole.headers["accept-ranges"], "bytes");
    assert.equal(Number(whole.headers["content-length"]), data.length);
    assert.equal(whole.rawPayload.length, data.length);

    const part = await ctx.app.inject({ url: src, headers: { range: "bytes=1000000-1000099" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers["content-range"], `bytes 1000000-1000099/${data.length}`);
    assert.equal(Number(part.headers["content-length"]), 100);
    assert.deepEqual(part.rawPayload, data.subarray(1000000, 1000100));

    const tail = await ctx.app.inject({ url: src, headers: { range: "bytes=-10" } });
    assert.equal(tail.statusCode, 206);
    assert.deepEqual(tail.rawPayload, data.subarray(data.length - 10));

    const bad = await ctx.app.inject({ url: src, headers: { range: `bytes=${data.length + 5}-` } });
    assert.equal(bad.statusCode, 416);
  });
});
