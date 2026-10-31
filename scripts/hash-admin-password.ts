/**
 * Gera o hash da senha do painel /admin.
 * Uso: npm run admin:password -- "minha senha"   (sem senha, gera uma aleatória)
 */
import { generateAppPassword, hashPassword } from "../api/auth.ts";

const given = process.argv[2];
const password = given ?? generateAppPassword();
if (!given) console.log(`Senha do painel (guarde no gerenciador de senhas): ${password}`);
console.log(`Variáveis de ambiente (cole no Easypanel, sem aspas; o usuário pode ser outro):\nADMIN_USER=admin\nADMIN_PASSWORD_HASH=${hashPassword(password)}`);
