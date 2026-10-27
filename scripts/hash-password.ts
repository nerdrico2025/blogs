/**
 * Gera uma senha de aplicação e o hash para o .env.
 * Uso: npm run api:password            (gera uma senha nova)
 *      npm run api:password -- "senha" (gera o hash de uma senha existente)
 */
import { generateAppPassword, hashPassword } from "../api/auth.ts";

const password = process.argv[2] ?? generateAppPassword();
console.log(`Senha de aplicação (cadastre no Wordbee): ${password}`);
console.log(`Variável de ambiente (cole no Easypanel ou no .env):\nWP_APP_PASSWORD_HASH=${hashPassword(password)}`);
