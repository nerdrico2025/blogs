/**
 * Trava global de build entre containers (vários blogs no mesmo VPS).
 * Uma pasta compartilhada (bind mount do host, ex.: /shared/build-locks) tem N vagas:
 * slot-0.lock … slot-(N-1).lock. Pegar uma vaga = criar o arquivo com O_EXCL.
 * Enquanto o build roda, o mtime do arquivo é atualizado (heartbeat); uma vaga sem
 * heartbeat há mais de `staleMs` é considerada abandonada (container morto) e pode ser retomada.
 * Quem não consegue vaga espera com jitter. Nada disso afeta a resposta da API ao Wordbee:
 * o build já roda fora do ciclo da requisição.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface LockOptions {
  dir: string;
  slots: number;
  owner: string;
  staleMs?: number;
  heartbeatMs?: number;
  /** Espera entre tentativas: base + jitter aleatório. */
  retryBaseMs?: number;
  retryJitterMs?: number;
  onWait?: (attempt: number) => void;
}

export interface Slot {
  slot: number;
  release(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GlobalBuildLock {
  private readonly o: Required<Omit<LockOptions, "onWait">> & Pick<LockOptions, "onWait">;

  constructor(options: LockOptions) {
    this.o = { staleMs: 10 * 60_000, heartbeatMs: 30_000, retryBaseMs: 5_000, retryJitterMs: 10_000, ...options };
  }

  private file(i: number): string {
    return path.join(this.o.dir, `slot-${i}.lock`);
  }

  /** Tenta pegar uma vaga sem esperar. */
  async tryAcquire(): Promise<Slot | null> {
    await mkdir(this.o.dir, { recursive: true });
    const token = randomUUID();
    for (let i = 0; i < this.o.slots; i++) {
      const file = this.file(i);
      if (await this.create(file, token)) return this.hold(i, file, token);
      if (await this.reclaimIfStale(file) && (await this.create(file, token))) return this.hold(i, file, token);
    }
    return null;
  }

  /** Espera até conseguir uma vaga. */
  async acquire(): Promise<Slot> {
    for (let attempt = 1; ; attempt++) {
      const slot = await this.tryAcquire();
      if (slot) return slot;
      this.o.onWait?.(attempt);
      await sleep(this.o.retryBaseMs + Math.random() * this.o.retryJitterMs);
    }
  }

  private async create(file: string, token: string): Promise<boolean> {
    try {
      const fh = await open(file, "wx");
      await fh.writeFile(JSON.stringify({ token, owner: this.o.owner, host: os.hostname(), pid: process.pid, at: new Date().toISOString() }));
      await fh.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  /** Vaga sem heartbeat há mais de staleMs: renomeia (só um container consegue) e apaga. */
  private async reclaimIfStale(file: string): Promise<boolean> {
    try {
      const s = await stat(file);
      if (Date.now() - s.mtimeMs < this.o.staleMs) return false;
      const tomb = `${file}.stale-${randomUUID()}`;
      await rename(file, tomb);
      await unlink(tomb).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  private hold(slot: number, file: string, token: string): Slot {
    const timer = setInterval(() => {
      const now = new Date();
      utimes(file, now, now).catch(() => {});
    }, this.o.heartbeatMs);
    timer.unref();
    return {
      slot,
      release: async () => {
        clearInterval(timer);
        try {
          // Só apaga se a vaga ainda for nossa (pode ter sido retomada se ficamos parados tempo demais)
          const data = JSON.parse(await readFile(file, "utf8")) as { token?: string };
          if (data.token === token) await unlink(file);
        } catch {}
      },
    };
  }
}
