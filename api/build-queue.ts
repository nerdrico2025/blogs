/**
 * Fila de build com debounce: várias publicações seguidas viram um build só.
 * Cada build vai para uma pasta nova em releases/ e, se der certo, o symlink
 * `current` (raiz do Nginx) passa a apontar para ela com um rename atômico.
 * Se o build falhar, o site continua no release anterior.
 */
import { spawn } from "node:child_process";
import { cp, readdir, readlink, rename, rm, symlink, mkdir } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { GlobalBuildLock } from "./build-lock.ts";
import type { ApiEnv } from "./env.ts";
import { precompress } from "./precompress.ts";

export interface BuildStatus {
  /** waiting: debounce; waiting-slot: esperando vaga na trava global; building: rodando. */
  state: "idle" | "waiting" | "waiting-slot" | "building";
  pending: boolean;
  lastBuild?: { ok: boolean; finishedAt: string; durationMs: number; release?: string; error?: string; reasons: string[] };
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (b: Buffer) => {
      output = (output + b.toString()).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(args[0] ?? cmd)} saiu com código ${code}\n${output}`))));
  });
}

export class BuildQueue {
  private timer: NodeJS.Timeout | null = null;
  private firstRequestAt = 0;
  private running: Promise<void> | null = null;
  private dirty = false;
  private reasons: string[] = [];
  private failuresInARow = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private status: BuildStatus = { state: "idle", pending: false };
  private readonly env: ApiEnv;
  private readonly log: FastifyBaseLogger;
  private readonly lock: GlobalBuildLock | null;
  private gate: () => boolean = () => true;

  constructor(env: ApiEnv, log: FastifyBaseLogger) {
    this.env = env;
    this.log = log;
    this.lock = env.globalBuildLockDir
      ? new GlobalBuildLock({
          dir: env.globalBuildLockDir,
          slots: env.globalBuildSlots,
          owner: env.site,
          onWait: (attempt) => {
            if (attempt === 1 || attempt % 12 === 0) this.log.info({ attempt }, "aguardando vaga de build (outros blogs estão buildando)");
          },
        })
      : null;
  }

  /** Enquanto o blog não estiver configurado, pedidos de build (agendador, /internal) são ignorados. */
  setGate(gate: () => boolean): void {
    this.gate = gate;
  }

  getStatus(): BuildStatus {
    return { ...this.status, pending: this.dirty || this.timer !== null };
  }

  /** Pede um build. Espera `buildDebounceMs` sem novos pedidos (no máximo `buildMaxWaitMs`). */
  request(reason: string): void {
    if (this.env.buildMode === "none" || !this.gate()) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.reasons.push(reason);
    const now = Date.now();
    if (!this.timer) this.firstRequestAt = now;
    if (this.timer) clearTimeout(this.timer);
    const waited = now - this.firstRequestAt;
    const delay = Math.max(0, Math.min(this.env.buildDebounceMs, this.env.buildMaxWaitMs - waited));
    if (this.status.state === "idle") this.status.state = "waiting";
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, delay);
  }

  /** Aguarda a fila esvaziar (testes e desligamento). */
  async drain(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    while (this.timer || this.running) {
      if (this.running) await this.running;
      else await new Promise((r) => setTimeout(r, 50));
    }
  }

  private start(): void {
    if (this.running) {
      this.dirty = true;
      return;
    }
    const reasons = this.reasons;
    this.reasons = [];
    this.running = this.build(reasons).finally(() => {
      this.running = null;
      if (this.dirty) {
        this.dirty = false;
        this.start();
      } else if (!this.timer) this.status.state = "idle";
    });
  }

  private async build(reasons: string[]): Promise<void> {
    // Só um build por container (fila) e no máximo N no VPS inteiro (trava global)
    let slot: Awaited<ReturnType<GlobalBuildLock["acquire"]>> | null = null;
    if (this.lock) {
      this.status.state = "waiting-slot";
      slot = await this.lock.acquire();
    }
    try {
      await this.buildRelease(reasons);
    } finally {
      await slot?.release();
    }
  }

  private async buildRelease(reasons: string[]): Promise<void> {
    const started = Date.now();
    const release = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "") + "-" + process.pid;
    const outDir = path.join(this.env.releasesDir, release);
    // O Astro move arquivos (rename) da pasta interna dele para o outDir; entre o disco do container
    // e o volume /data isso falha (EXDEV). Então o build sai numa pasta do próprio projeto e é copiado
    // para o volume como .partial, renomeado (mesmo disco, atômico) e só então publicado.
    const staging = path.join(this.env.projectDir, ".astro", "staging", release);
    const partial = `${outDir}.partial`;
    this.status.state = "building";
    this.log.info({ release, reasons }, "build iniciado");
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      SITE: this.env.site,
      CONTENT_DIR: this.env.contentDir,
      UPLOADS_DIR: this.env.uploadsDir,
      PAGES_DIR: this.env.pagesDir,
      SETTINGS_FILE: this.env.settingsFile,
      ASSETS_DIR: this.env.assetsDir,
      BUILD_CACHE_DIR: this.env.buildCacheDir,
      ASTRO_TELEMETRY_DISABLED: "1",
    };
    if (this.env.buildMaxOldSpaceMb > 0) {
      childEnv.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${this.env.buildMaxOldSpaceMb}`.trim();
    }
    const bin = (p: string) => path.join(this.env.projectDir, "node_modules", p);
    try {
      await mkdir(this.env.releasesDir, { recursive: true });
      await run(process.execPath, [bin("astro/bin/astro.mjs"), "build", "--outDir", staging], this.env.projectDir, childEnv);
      await run(process.execPath, [bin("pagefind/lib/runner/bin.cjs"), "--site", staging, "--silent"], this.env.projectDir, childEnv);
      await precompress(staging);
      await cp(staging, partial, { recursive: true });
      await rename(partial, outDir);
      await rm(staging, { recursive: true, force: true });
      await this.swap(outDir);
      await this.prune(release);
      const durationMs = Date.now() - started;
      this.status.lastBuild = { ok: true, finishedAt: new Date().toISOString(), durationMs, release, reasons };
      this.failuresInARow = 0;
      this.log.info({ release, durationMs }, "build publicado");
    } catch (err) {
      const error = (err as Error).message;
      this.status.lastBuild = { ok: false, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, error, reasons };
      this.log.error({ release, err: error }, "build falhou; o site continua no release anterior");
      for (const dir of [staging, partial, outDir]) await rm(dir, { recursive: true, force: true });
      this.scheduleRetry();
    }
  }

  /** Falhas passageiras (disco, rede): tenta de novo em 2, 4 e 8 min. Depois, só no próximo post. */
  private scheduleRetry(): void {
    this.failuresInARow++;
    if (this.failuresInARow > 3) return;
    const delay = 60_000 * 2 ** this.failuresInARow;
    this.log.warn({ delayMs: delay, attempt: this.failuresInARow }, "nova tentativa de build agendada");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.request(`nova tentativa ${this.failuresInARow}`);
    }, delay);
    this.retryTimer.unref();
  }

  /** Troca atômica: cria um symlink temporário e renomeia por cima de `current`. */
  private async swap(outDir: string): Promise<void> {
    const tmp = `${this.env.currentLink}.tmp-${process.pid}`;
    await rm(tmp, { force: true });
    await symlink(outDir, tmp, "dir");
    await rename(tmp, this.env.currentLink);
  }

  /** Mantém os `keepReleases` mais recentes (e sempre o atual). */
  private async prune(current: string): Promise<void> {
    let active = current;
    try {
      active = path.basename(await readlink(this.env.currentLink));
    } catch {}
    const all = (await readdir(this.env.releasesDir)).filter((d) => !d.startsWith(".") && !d.endsWith(".partial")).sort();
    const keep = new Set([...all.slice(-this.env.keepReleases), active]);
    for (const d of all) if (!keep.has(d)) await rm(path.join(this.env.releasesDir, d), { recursive: true, force: true });
  }
}
