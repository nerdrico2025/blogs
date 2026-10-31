/**
 * Configuração do servidor (API + site estático), só por variáveis de ambiente.
 * Em desenvolvimento, os dados ficam em .local/<SITE>/; no container, em /data (ver Dockerfile).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { cleanEnvValue } from "./auth.ts";
import { assetsRoot, settingsFile } from "../shared/settings.ts";
import { hasSiteFolder, localDataDir, siteDir, siteId } from "../src/lib/site-id.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

const num = (name: string, def: number) => (process.env[name] ? Number(process.env[name]) : def);

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix: string;
}

export interface ApiEnv {
  site: string;
  host: string;
  port: number;
  user: string;
  passwordHash: string;
  /** Raiz do projeto Astro (onde fica package.json). */
  projectDir: string;
  contentDir: string;
  pagesDir: string;
  uploadsDir: string;
  stateFile: string;
  settingsFile: string;
  secretsFile: string;
  assetsDir: string;
  /** Painel /admin (têm prioridade sobre o secrets.json). */
  adminUser: string;
  adminPasswordHash: string;
  /** Vazio = assistente /admin/setup desligado. */
  setupToken: string;
  anthropicApiKey: string;
  aiModel: string;
  buildCacheDir: string;
  backupDir: string;
  /** "release": build em pasta nova + troca de symlink; "none": não faz build (testes). */
  buildMode: "release" | "none";
  releasesDir: string;
  currentLink: string;
  keepReleases: number;
  buildDebounceMs: number;
  buildMaxWaitMs: number;
  /** Heap máximo (MB) do processo de build (--max-old-space-size). 0 = padrão do Node. */
  buildMaxOldSpaceMb: number;
  /** Pasta compartilhada entre os containers do VPS para a trava global de build (vazio = sem trava). */
  globalBuildLockDir: string;
  /** Builds simultâneos permitidos no VPS inteiro. */
  globalBuildSlots: number;
  maxUploadBytes: number;
  rateLimitPerMinute: number;
  /** Número de proxies confiáveis à frente (Traefik = 1). 0 desliga. */
  trustProxyHops: number;
  /** Servir o site estático (current/) e os uploads. Desligado nos testes da API. */
  serveStatic: boolean;
  /** Agendador interno (rebuild e backup diários). */
  scheduler: boolean;
  /** Hora UTC do rebuild e do backup diários; o minuto vem de um hash do SITE. */
  dailyRebuildUtcHour: number;
  dailyBackupUtcHour: number;
  scheduleMinute: number;
  backupRetentionDays: number;
  s3: S3Config | null;
}

function s3FromEnv(): S3Config | null {
  const endpoint = process.env.BACKUP_S3_ENDPOINT;
  const bucket = process.env.BACKUP_S3_BUCKET;
  if (!endpoint || !bucket) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    region: process.env.BACKUP_S3_REGION ?? "us-east-1",
    bucket,
    accessKey: required("BACKUP_S3_ACCESS_KEY"),
    secretKey: required("BACKUP_S3_SECRET_KEY"),
    prefix: (process.env.BACKUP_S3_PREFIX ?? siteId()).replace(/^\/+|\/+$/g, ""),
  };
}

function trustProxy(): number {
  const v = process.env.TRUST_PROXY ?? "1";
  if (v === "true") return 1;
  if (v === "false") return 0;
  return Number(v) || 0;
}

export function loadEnv(overrides: Partial<ApiEnv> = {}): ApiEnv {
  const projectDir = path.resolve(process.env.PROJECT_DIR ?? ".");
  const site = siteId();
  const local = localDataDir(projectDir);
  const minute = createHash("sha256").update(site).digest().readUInt16BE(0) % 60;
  const env: ApiEnv = {
    site,
    host: process.env.HOST ?? process.env.API_HOST ?? "127.0.0.1",
    port: num("PORT", num("API_PORT", 8787)),
    // Sem as variáveis, a senha do Wordbee é a do secrets.json (gerada pelo assistente ou no /admin)
    user: cleanEnvValue(process.env.WP_USER) || (cleanEnvValue(process.env.WP_APP_PASSWORD_HASH) ? required("WP_USER") : "wordbee"),
    passwordHash: cleanEnvValue(process.env.WP_APP_PASSWORD_HASH),
    projectDir,
    contentDir: path.resolve(process.env.CONTENT_DIR ?? path.join(local, "content/posts")),
    // Blog sem pasta em sites/: as páginas fixas ficam no volume, ao lado do settings.json
    pagesDir: path.resolve(process.env.PAGES_DIR ?? (hasSiteFolder(projectDir) ? path.join(siteDir(projectDir), "pages") : path.join(path.dirname(settingsFile()), "pages"))),
    uploadsDir: path.resolve(process.env.UPLOADS_DIR ?? path.join(local, "uploads")),
    stateFile: path.resolve(process.env.STATE_FILE ?? path.join(local, "data/api-state.json")),
    settingsFile: settingsFile(),
    secretsFile: path.resolve(process.env.SECRETS_FILE ?? path.join(path.dirname(settingsFile()), "secrets.json")),
    assetsDir: assetsRoot(),
    adminUser: cleanEnvValue(process.env.ADMIN_USER),
    adminPasswordHash: cleanEnvValue(process.env.ADMIN_PASSWORD_HASH),
    setupToken: cleanEnvValue(process.env.SETUP_TOKEN),
    anthropicApiKey: cleanEnvValue(process.env.ANTHROPIC_API_KEY),
    aiModel: process.env.AI_MODEL || "claude-sonnet-5-5",
    buildCacheDir: path.resolve(process.env.BUILD_CACHE_DIR ?? path.join(local, "data/build-cache")),
    backupDir: path.resolve(process.env.BACKUP_DIR ?? path.join(local, "backups")),
    buildMode: process.env.BUILD_MODE === "none" ? "none" : "release",
    releasesDir: path.resolve(process.env.RELEASES_DIR ?? path.join(local, "releases")),
    currentLink: path.resolve(process.env.CURRENT_LINK ?? path.join(local, "current")),
    keepReleases: num("KEEP_RELEASES", 3),
    buildDebounceMs: num("BUILD_DEBOUNCE_MS", 5000),
    buildMaxWaitMs: num("BUILD_MAX_WAIT_MS", 30000),
    buildMaxOldSpaceMb: num("BUILD_MAX_OLD_SPACE_MB", 0),
    globalBuildLockDir: process.env.GLOBAL_BUILD_LOCK_DIR ? path.resolve(process.env.GLOBAL_BUILD_LOCK_DIR) : "",
    // Pico medido de um build completo: ~460 MB (500 posts), abaixo de 1 GB, então 2 vagas por padrão
    globalBuildSlots: Math.max(1, num("GLOBAL_BUILD_SLOTS", 2)),
    maxUploadBytes: num("MAX_UPLOAD_MB", 16) * 1024 * 1024,
    rateLimitPerMinute: num("RATE_LIMIT_PER_MINUTE", 120),
    trustProxyHops: trustProxy(),
    serveStatic: process.env.SERVE_STATIC !== "false",
    scheduler: process.env.SCHEDULER !== "false",
    dailyRebuildUtcHour: num("DAILY_REBUILD_UTC_HOUR", 7),
    dailyBackupUtcHour: num("DAILY_BACKUP_UTC_HOUR", 6),
    scheduleMinute: num("SCHEDULE_MINUTE", minute),
    backupRetentionDays: num("BACKUP_RETENTION_DAYS", 14),
    s3: s3FromEnv(),
    ...overrides,
  };
  return env;
}
