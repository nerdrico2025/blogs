/**
 * No container, comandos do console (Easypanel) rodam como root. Arquivos criados assim em /data
 * ficariam inacessíveis para o servidor, que roda como "node". Este módulo troca para o usuário
 * "node" logo no início, quando o processo é root e esse usuário existe.
 */
import { execFileSync } from "node:child_process";

if (process.getuid?.() === 0) {
  try {
    const uid = Number(execFileSync("id", ["-u", "node"]).toString().trim());
    const gid = Number(execFileSync("id", ["-g", "node"]).toString().trim());
    process.setgid!(gid);
    process.setuid!(uid);
  } catch {
    // Sem usuário "node" (fora do container): segue como está
  }
}
