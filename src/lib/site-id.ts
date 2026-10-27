import path from "node:path";

/** Nome da pasta do blog em sites/ (variável SITE). */
export function siteId(): string {
  const id = process.env.SITE ?? "exemplo";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`SITE inválido: "${id}" (use letras minúsculas, números e hífen).`);
  return id;
}

/** Pasta do blog: sites/<SITE>/ */
export function siteDir(root = process.cwd()): string {
  return path.join(root, "sites", siteId());
}

/**
 * Pasta de dados locais (desenvolvimento): .local/<SITE>/. Em produção, as variáveis
 * CONTENT_DIR, UPLOADS_DIR etc. apontam para o volume /data.
 */
export function localDataDir(root = process.cwd()): string {
  return path.join(root, ".local", siteId());
}
