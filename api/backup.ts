/**
 * Backup do conteúdo do blog: posts, imagens e estado da API num .tar.gz em BACKUP_DIR,
 * com retenção de N dias e cópia opcional para S3-compatível.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApiEnv } from "./env.ts";
import { uploadFile } from "./s3.ts";

function tar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (b) => (err = (err + b).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar saiu com código ${code}: ${err}`))));
  });
}

export interface BackupResult {
  file: string;
  bytes: number;
  uploaded: boolean;
  removed: number;
}

export async function runBackup(env: ApiEnv): Promise<BackupResult> {
  await mkdir(env.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const name = `blog-${env.site}-${stamp}.tar.gz`;
  const file = path.join(env.backupDir, name);

  // Pasta temporária com links para as três origens: o arquivo fica com content/, uploads/ e data/
  const stage = await mkdtemp(path.join(os.tmpdir(), "blog-backup-"));
  try {
    await symlink(env.contentDir, path.join(stage, "content"));
    await symlink(env.uploadsDir, path.join(stage, "uploads"));
    await symlink(path.dirname(env.stateFile), path.join(stage, "data"));
    // Configurações do /admin, quando existirem: settings.json, secrets.json (só hashes), assets/ e pages/
    const optional: string[] = [];
    for (const [source, name] of [[env.settingsFile, "settings.json"], [env.secretsFile, "secrets.json"], [env.assetsDir, "assets"], [path.dirname(env.settingsFile) + "/pages", "pages"]] as const) {
      if (!existsSync(source)) continue;
      await symlink(source, path.join(stage, name));
      optional.push(name);
    }
    await tar(["-czhf", `${file}.partial`, "-C", stage, "content", "uploads", "data", ...optional]);
    await rename(`${file}.partial`, file);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  let uploaded = false;
  if (env.s3) {
    await uploadFile(env.s3, file, `${env.s3.prefix}/${name}`);
    uploaded = true;
  }

  let removed = 0;
  const limit = Date.now() - env.backupRetentionDays * 86_400_000;
  for (const f of await readdir(env.backupDir)) {
    if (!/^blog-.*\.tar\.gz$/.test(f)) continue;
    const p = path.join(env.backupDir, f);
    if ((await stat(p)).mtimeMs < limit) {
      await rm(p);
      removed++;
    }
  }
  return { file, bytes: (await stat(file)).size, uploaded, removed };
}
