/** Faz um backup agora (e envia ao S3, se configurado). Uso: npm run backup */
import "./lib/drop-root.ts";
import { loadEnv } from "../api/env.ts";
import { runBackup } from "../api/backup.ts";

const r = await runBackup(loadEnv());
console.log(`Backup: ${r.file} (${(r.bytes / 1048576).toFixed(1)} MB)${r.uploaded ? ", enviado ao S3" : ""}; ${r.removed} antigo(s) removido(s).`);
