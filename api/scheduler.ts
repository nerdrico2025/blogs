/**
 * Agendador interno (substitui o cron do host): rebuild diário, para atualizar cotação e último vídeo,
 * e backup diário. O minuto vem de um hash do SITE, para vários blogs no mesmo servidor
 * não rodarem ao mesmo tempo.
 */
import type { FastifyBaseLogger } from "fastify";
import { runBackup } from "./backup.ts";
import type { BuildQueue } from "./build-queue.ts";
import type { ApiEnv } from "./env.ts";

/** Próximo instante (UTC) com a hora e o minuto dados, depois de `from`. */
export function nextRun(hour: number, minute: number, from = new Date()): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, minute));
  if (d.getTime() <= from.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private readonly env: ApiEnv;
  private readonly builds: BuildQueue;
  private readonly log: FastifyBaseLogger;

  constructor(env: ApiEnv, builds: BuildQueue, log: FastifyBaseLogger) {
    this.env = env;
    this.builds = builds;
    this.log = log;
  }

  start(): void {
    this.daily("rebuild diário", this.env.dailyRebuildUtcHour, async () => this.builds.request("rebuild diário"));
    this.daily("backup diário", this.env.dailyBackupUtcHour, async () => {
      const r = await runBackup(this.env);
      this.log.info({ file: r.file, bytes: r.bytes, uploaded: r.uploaded, removed: r.removed }, "backup concluído");
    });
  }

  stop(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  private daily(name: string, hour: number, task: () => Promise<void>): void {
    const at = nextRun(hour, this.env.scheduleMinute);
    this.log.info({ task: name, at: at.toISOString() }, "tarefa agendada");
    const timer = setTimeout(async () => {
      try {
        await task();
      } catch (err) {
        this.log.error({ task: name, err: (err as Error).message }, "tarefa agendada falhou");
      }
      this.daily(name, hour, task);
    }, at.getTime() - Date.now());
    timer.unref();
    this.timers.push(timer);
  }
}
