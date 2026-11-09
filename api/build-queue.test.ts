/**
 * Publicação: nome único por build e nenhuma falha apaga o release no ar. Usa um Astro e um Pagefind de mentira,
 * instantâneos, para vários builds caberem no mesmo segundo (o caso que fazia o segundo apagar o primeiro).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";

const tmp = await mkdtemp(path.join(os.tmpdir(), "blog-queue-"));
process.env.SITE = "exemplo";
process.env.SETTINGS_FILE = path.join(tmp, "settings.json");
const { loadEnv } = await import("./env.ts");
const { BuildQueue } = await import("./build-queue.ts");

const log = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;
const failFlag = path.join(tmp, "falhar");
const FAKE_ASTRO = `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--outDir") + 1];
if (existsSync(${JSON.stringify(failFlag)})) { console.error("build de teste falhou"); process.exit(1); }
mkdirSync(out, { recursive: true });
writeFileSync(out + "/index.html", "<h1>" + process.pid + "</h1>");
`;

function queue(name: string): InstanceType<typeof BuildQueue> {
  const base = loadEnv({ user: "w", passwordHash: "x", contentDir: path.join(tmp, "posts"), uploadsDir: path.join(tmp, "uploads"), stateFile: path.join(tmp, "s.json"), secretsFile: path.join(tmp, "sec.json"), scheduler: false });
  return new BuildQueue(
    { ...base, projectDir: tmp, site: name, buildMode: "release", buildDebounceMs: 0, releasesDir: path.join(tmp, "releases"), currentLink: path.join(tmp, "current"), keepReleases: 50, globalBuildLockDir: "", buildMaxOldSpaceMb: 0 },
    log
  );
}
const current = () => path.join(tmp, "current", "index.html");
const release = (q: InstanceType<typeof BuildQueue>) => q.getStatus().lastBuild?.release;

before(async () => {
  await mkdir(path.join(tmp, "node_modules/astro/bin"), { recursive: true });
  await mkdir(path.join(tmp, "node_modules/pagefind/lib/runner"), { recursive: true });
  await writeFile(path.join(tmp, "node_modules/astro/bin/astro.mjs"), FAKE_ASTRO);
  await writeFile(path.join(tmp, "node_modules/pagefind/lib/runner/bin.cjs"), "");
});
after(() => rm(tmp, { recursive: true, force: true }));

describe("nome do release e falhas de build", () => {
  test("dois builds simultâneos: cada um com sua pasta, os dois publicam e o site fica de pé", async () => {
    const [a, b] = [queue("a"), queue("b")];
    a.request("x");
    b.request("y");
    await Promise.all([a.drain(), b.drain()]);
    assert.equal(a.getStatus().lastBuild?.ok, true, a.getStatus().lastBuild?.error);
    assert.equal(b.getStatus().lastBuild?.ok, true, b.getStatus().lastBuild?.error);
    assert.notEqual(release(a), release(b));
    assert.ok(existsSync(path.join(tmp, "releases", release(a)!)) && existsSync(path.join(tmp, "releases", release(b)!)));
    assert.ok([release(a), release(b)].includes(path.basename(readlinkSync(path.join(tmp, "current")))));
    assert.ok(existsSync(current()));
    assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith("current.tmp")), []);
  });

  test("oito builds em sequência rápida têm nomes diferentes e terminam publicados", async () => {
    const q = queue("c");
    const names = new Set<string>();
    for (let i = 0; i < 8; i++) {
      q.request(`b${i}`);
      await q.drain();
      assert.equal(q.getStatus().lastBuild?.ok, true, q.getStatus().lastBuild?.error);
      names.add(release(q)!);
      assert.ok(existsSync(current()), `build ${i}: o release no ar sumiu`);
    }
    assert.equal(names.size, 8);
  });

  test("build que falha mantém o release no ar", async () => {
    const q = queue("d");
    q.request("bom");
    await q.drain();
    const live = readlinkSync(path.join(tmp, "current"));
    const page = readFileSync(current(), "utf8");
    await writeFile(failFlag, "");
    try {
      q.request("ruim");
      await q.drain();
      assert.equal(q.getStatus().lastBuild?.ok, false);
    } finally {
      await rm(failFlag);
    }
    assert.equal(readlinkSync(path.join(tmp, "current")), live);
    assert.equal(readFileSync(current(), "utf8"), page);
  });

  test("troca que falha depois de mover a pasta apaga só a pasta nova", async () => {
    const q = queue("e");
    q.request("bom");
    await q.drain();
    const live = readlinkSync(path.join(tmp, "current"));
    const before = new Set(readdirSync(path.join(tmp, "releases")));
    // `current` passa a ser uma pasta com conteúdo: o rename do symlink falha
    const link = path.join(tmp, "current");
    await rm(link);
    await mkdir(path.join(link, "x"), { recursive: true });
    try {
      q.request("troca");
      await q.drain();
      assert.equal(q.getStatus().lastBuild?.ok, false);
      assert.deepEqual(new Set(readdirSync(path.join(tmp, "releases"))), before);
    } finally {
      await rm(link, { recursive: true });
      const { symlink } = await import("node:fs/promises");
      await symlink(live, link, "dir");
    }
    assert.ok(existsSync(current()));
  });
});
