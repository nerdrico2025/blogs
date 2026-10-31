/**
 * Confere uma senha com o ADMIN_PASSWORD_HASH do ambiente, usando o mesmo código do login.
 * Uso (no Console do Easypanel): npm run admin:verify -- 'minha senha'
 * Saída: "confere" (código 0) ou "não confere" (código 1). Nunca imprime senha nem hash.
 * Código 2: não deu para comparar (senha não informada, variável ausente ou hash inválido).
 */
import { cleanEnvValue, isValidHash, verifyPassword } from "../api/auth.ts";

const password = process.argv[2];
const stored = cleanEnvValue(process.env.ADMIN_PASSWORD_HASH);

function stop(message: string): never {
  console.error(message);
  process.exit(2);
}

if (!password) stop("Uso: npm run admin:verify -- '<senha>'");
if (!stored) stop("ADMIN_PASSWORD_HASH não está definida neste ambiente.");
if (!isValidHash(stored)) stop("ADMIN_PASSWORD_HASH está em formato inválido: o valor foi alterado ao ser colado. Gere de novo com npm run admin:password.");

const ok = verifyPassword(password, stored);
console.log(ok ? "confere" : "não confere");
process.exit(ok ? 0 : 1);
