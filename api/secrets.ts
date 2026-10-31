/**
 * Segredos gerados pelo blog (/data/secrets.json, permissão 600): só hashes scrypt.
 * Variáveis de ambiente têm prioridade (ver env.ts e server.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Secrets {
  adminUser?: string;
  adminPasswordHash?: string;
  wordbeeUser?: string;
  wordbeePasswordHash?: string;
}

export class SecretStore {
  private readonly file: string;
  data: Secrets;

  constructor(file: string) {
    this.file = file;
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Secrets) : {};
  }

  async update(patch: Secrets): Promise<void> {
    const next = { ...this.data, ...patch };
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
    this.data = next;
  }
}
