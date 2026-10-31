import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Nome do blog (variável SITE). Sem a variável, vale o exemplo (desenvolvimento);
 * vazia, é um blog criado pelo assistente de primeiro acesso, sem pasta em sites/.
 */
export function siteId(): string {
  const id = process.env.SITE === undefined ? "exemplo" : process.env.SITE.trim() || "blog";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`SITE inválido: "${id}" (use letras minúsculas, números e hífen).`);
  return id;
}

export function hasSiteFolder(root = process.cwd()): boolean {
  return existsSync(path.join(root, "sites", siteId(), "site.config.ts"));
}

/** Pasta do blog: sites/<SITE>/; sem ela, o modelo neutro sites/_base/. */
export function siteDir(root = process.cwd()): string {
  return path.join(root, "sites", hasSiteFolder(root) ? siteId() : "_base");
}

/**
 * Pasta de dados locais (desenvolvimento): .local/<SITE>/. Em produção, as variáveis
 * CONTENT_DIR, UPLOADS_DIR etc. apontam para o volume /data.
 */
export function localDataDir(root = process.cwd()): string {
  return path.join(root, ".local", siteId());
}
