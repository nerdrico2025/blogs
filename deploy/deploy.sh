#!/usr/bin/env bash
# ALTERNATIVA SEM EASYPANEL: o caminho principal é o Docker no Easypanel (docs/deploy-easypanel.md).
# Este arquivo só serve para instalar o blog direto num VPS com Nginx + systemd.
# Envia o código para o VPS, instala dependências, reinicia a API e publica um build.
# Uso (na sua máquina, na raiz do projeto):
#   deploy/deploy.sh <usuario@host> <dominio> [--setup <email>] [--seed]
#     --setup <email>  roda o setup-server.sh antes (primeira vez)
#     --seed           copia os posts e imagens de exemplo se o conteúdo estiver vazio
# O usuário SSH precisa ser root ou ter sudo sem senha.
set -euo pipefail

TARGET="${1:?informe usuario@host}"
DOMAIN="${2:?informe o domínio}"
shift 2
SETUP_EMAIL=""
SEED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --setup) SETUP_EMAIL="${2:?informe o e-mail}"; shift 2 ;;
    --seed) SEED=1; shift ;;
    *) echo "opção desconhecida: $1"; exit 1 ;;
  esac
done
ROOT="/srv/blog"
SSH=(ssh -o StrictHostKeyChecking=accept-new "$TARGET")

if [ -n "$SETUP_EMAIL" ]; then
  echo "==> Setup do servidor"
  "${SSH[@]}" "mkdir -p /tmp/blog-setup"
  scp -q deploy/setup-server.sh deploy/nginx-blog.conf deploy/nginx-security-headers.conf deploy/blog-api.service deploy/backup.sh "$TARGET:/tmp/blog-setup/"
  "${SSH[@]}" "sudo bash /tmp/blog-setup/setup-server.sh '$DOMAIN' '$SETUP_EMAIL'"
fi

echo "==> Enviando código"
rsync -az --delete --rsync-path="sudo rsync" \
  --exclude node_modules --exclude dist --exclude .astro --exclude .git --exclude .cache \
  --exclude .env --exclude data --exclude releases --exclude current \
  --exclude .local \
  ./ "$TARGET:$ROOT/app/"

"${SSH[@]}" "sudo ROOT='$ROOT' DOMAIN='$DOMAIN' SEED='$SEED' SITE='${SITE:-}' bash -s" <<'REMOTE'
set -euo pipefail
cd "$ROOT/app"
chown -R blog:blog "$ROOT/app"
as_blog() { sudo -u blog -H env HOME="$ROOT" "$@"; }

echo "==> Dependências"
as_blog npm ci --omit=dev --no-audit --no-fund --loglevel=error

ENVFILE=/etc/blog/api.env
if [ ! -f "$ENVFILE" ]; then
  echo "==> Criando credenciais (primeira vez)"
  OUT="$(as_blog node scripts/hash-password.ts)"
  PASS="$(printf '%s\n' "$OUT" | sed -n 's/^Senha de aplicação (cadastre no Wordbee): //p')"
  HASH="$(printf '%s\n' "$OUT" | sed -n 's/^WP_APP_PASSWORD_HASH=//p')"
  umask 027
  cat > "$ENVFILE" <<EOF
SITE=${SITE:?defina SITE=<pasta em sites/> ao rodar o deploy}
SITE_URL=https://$DOMAIN
WP_USER=wordbee
WP_APP_PASSWORD_HASH='$HASH'
API_HOST=127.0.0.1
API_PORT=8787
TRUST_PROXY=true
PROJECT_DIR=$ROOT/app
CONTENT_DIR=$ROOT/content/posts
UPLOADS_DIR=$ROOT/uploads
STATE_FILE=$ROOT/data/api-state.json
RELEASES_DIR=$ROOT/releases
CURRENT_LINK=$ROOT/current
BUILD_CACHE_DIR=$ROOT/data/build-cache
BACKUP_DIR=$ROOT/backups
SCHEDULER=false
EOF
  chown root:blog "$ENVFILE"
  chmod 0640 "$ENVFILE"
  echo ""
  echo "  ************************************************************"
  echo "  Cadastre no Wordbee como site WordPress:"
  echo "    URL:     https://$DOMAIN"
  echo "    Usuário: wordbee"
  echo "    Senha:   $PASS"
  echo "  (mostrada só agora; para trocar: apague $ENVFILE e rode o deploy de novo)"
  echo "  ************************************************************"
  echo ""
fi

if [ "$SEED" = 1 ] && [ -z "$(ls -A "$ROOT/content/posts")" ]; then
  echo "==> Copiando posts e imagens de exemplo"
  as_blog env CONTENT_DIR="$ROOT/content/posts" UPLOADS_DIR="$ROOT/uploads" npm run seed
fi

echo "==> Reiniciando a API"
systemctl restart blog-api
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8787/health; echo

echo "==> Build"
before="$(curl -fsS http://127.0.0.1:8787/health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).build.lastBuild?.finishedAt??""))')"
curl -fsS -X POST 'http://127.0.0.1:8787/internal/rebuild?reason=deploy' >/dev/null
for i in $(seq 1 180); do
  status="$(curl -fsS http://127.0.0.1:8787/health)"
  done_at="$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s).build;console.log(b.state==="idle"&&b.lastBuild?.finishedAt?b.lastBuild.finishedAt:"")})')"
  if [ -n "$done_at" ] && [ "$done_at" != "$before" ]; then
    printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s).build.lastBuild;console.log(b.ok?`build ok em ${b.durationMs} ms: ${b.release}`:`BUILD FALHOU: ${b.error}`);process.exit(b.ok?0:1)})'
    exit $?
  fi
  sleep 1
done
echo "build não terminou em 3 minutos; veja: journalctl -u blog-api -n 100"
exit 1
REMOTE

echo "==> Conferindo https://$DOMAIN/"
curl -fsS -o /dev/null -w "home → %{http_code}\n" "https://$DOMAIN/"
