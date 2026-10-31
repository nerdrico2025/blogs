/**
 * Basic Auth com "senha de aplicação". Só o hash (scrypt) fica no ambiente;
 * comparação em tempo constante. Falhas repetidas por IP geram bloqueio temporário.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { WpError } from "./errors.ts";

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

/** Senha no formato do WordPress: 24 caracteres em 6 grupos de 4. */
export function generateAppPassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(24);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return chars.join("").replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * O WordPress aceita a senha de aplicação com ou sem espaços. NFC: o mesmo "ç" pode vir com
 * bytes diferentes de um teclado para outro.
 */
const normalize = (password: string) => password.normalize("NFC").replace(/\s+/g, "");

/**
 * Painéis e arquivos de ambiente podem guardar as aspas como parte do valor (ADMIN_USER="rafael"
 * vira "rafael" com aspas) e espaços ou quebras de linha nas pontas. Tira só o que envolve o valor.
 */
export function cleanEnvValue(value: string | undefined): string {
  let v = (value ?? "").trim();
  while (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1).trim();
  return v;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(normalize(password), salt, KEYLEN, { N, r: R, p: P });
  // Sem "$": o valor vai para variáveis de ambiente, onde "$" pode ser interpretado (Docker, Easypanel)
  return `scrypt:${N}:${R}:${P}:${salt.toString("base64")}:${key.toString("base64")}`;
}

function parseHash(stored: string) {
  // Aceita "scrypt:..." (atual) e "scrypt$..." (formato antigo)
  const [alg, n, r, p, salt, key, ...rest] = cleanEnvValue(stored).split(/[:$]/);
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (alg !== "scrypt" || !salt || !key || rest.length > 0 || !Object.values(params).every((v) => Number.isInteger(v) && v > 0)) return null;
  const expected = Buffer.from(key, "base64");
  return expected.length > 0 ? { params, salt: Buffer.from(salt, "base64"), expected } : null;
}

export const isValidHash = (stored: string) => parseHash(stored) !== null;

export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const actual = scryptSync(normalize(password), parsed.salt, parsed.expected.length, parsed.params);
    return timingSafeEqual(actual, parsed.expected);
  } catch {
    // Parâmetros impossíveis no hash (ex.: N que não é potência de 2)
    return false;
  }
}

/** Sem senha cadastrada, o scrypt roda igual e o acesso é negado. */
const DUMMY_HASH = hashPassword("sem-senha-cadastrada");

const digest = (s: string) => createHash("sha256").update(s).digest();

export function parseBasic(header: string | undefined): { user: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

interface Failures {
  count: number;
  first: number;
}

/** Limite de tentativas por IP. */
export class Attempts {
  private failures = new Map<string, Failures>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max = 10, windowMs = 15 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  assertAllowed(ip: string): void {
    const f = this.failures.get(ip);
    if (f && Date.now() - f.first > this.windowMs) this.failures.delete(ip);
    const current = this.failures.get(ip);
    if (current && current.count >= this.max) {
      throw new WpError(429, "rest_too_many_attempts", "Muitas tentativas de login. Tente novamente mais tarde.");
    }
  }

  fail(ip: string): void {
    const entry = this.failures.get(ip) ?? { count: 0, first: Date.now() };
    entry.count++;
    this.failures.set(ip, entry);
  }

  clear(ip: string): void {
    this.failures.delete(ip);
  }
}

export type Credentials = { user: string; passwordHash: string };
/** Motivo da falha, para o log do servidor. Nunca inclui senha nem hash. */
export type LoginFailure = "usuário não confere" | "senha não confere" | "hash inválido" | "nenhuma senha cadastrada" | "bloqueado por tentativas";

export class Authenticator {
  private readonly attempts: Attempts;
  private readonly credentials: () => Credentials;
  private readonly onFailure?: (reason: LoginFailure, ip: string) => void;

  /** As credenciais são lidas a cada tentativa: a senha pode ser trocada sem reiniciar. */
  constructor(credentials: () => Credentials, maxFailures = 10, windowMs = 15 * 60_000, onFailure?: (reason: LoginFailure, ip: string) => void) {
    this.credentials = credentials;
    this.onFailure = onFailure;
    this.attempts = new Attempts(maxFailures, windowMs);
  }

  /** Lança WpError 401/429; retorna normalmente se as credenciais forem válidas. */
  check(header: string | undefined, ip: string): void {
    this.attempts.assertAllowed(ip);
    const creds = parseBasic(header);
    if (!creds) throw new WpError(401, "rest_not_logged_in", "Você não está autenticado.");
    this.checkPassword(creds.user, creds.password, ip);
  }

  checkPassword(user: string, password: string, ip: string): void {
    try {
      this.attempts.assertAllowed(ip);
    } catch (err) {
      this.onFailure?.("bloqueado por tentativas", ip);
      throw err;
    }
    const expected = this.credentials();
    // Compara o usuário por hash (tamanho fixo) e sempre roda o scrypt, para não vazar tempo
    const userOk = timingSafeEqual(digest(user), digest(expected.user));
    const hashOk = isValidHash(expected.passwordHash);
    const passOk = verifyPassword(password, hashOk ? expected.passwordHash : DUMMY_HASH);
    if (!userOk || !passOk || !hashOk) {
      this.attempts.fail(ip);
      this.onFailure?.(!expected.passwordHash ? "nenhuma senha cadastrada" : !hashOk ? "hash inválido" : !userOk ? "usuário não confere" : "senha não confere", ip);
      throw new WpError(401, "incorrect_password", "Usuário ou senha inválidos.");
    }
    this.attempts.clear(ip);
  }
}
