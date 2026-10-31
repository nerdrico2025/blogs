import { existsSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { Scheduler } from "./scheduler.ts";
import { buildApp } from "./server.ts";

const env = loadEnv();
const { app, builds } = await buildApp(env);
const scheduler = env.scheduler ? new Scheduler(env, builds, app.log) : null;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, "encerrando: aguardando builds em andamento");
    scheduler?.stop();
    await app.close();
    await builds.drain();
    process.exit(0);
  });
}

await app.listen({ host: env.host, port: env.port });
scheduler?.start();
app.log.info({ site: env.site, s3Backup: Boolean(env.s3) }, "blog no ar");

// Sem release publicado ainda (primeira subida do container): publica um
// (a fila ignora o pedido enquanto o assistente não terminar)
if (!existsSync(env.currentLink)) builds.request("primeira publicação");
