#!/usr/bin/env bash
# ALTERNATIVA SEM EASYPANEL: o caminho principal é o Docker no Easypanel (docs/deploy-easypanel.md).
# Este arquivo só serve para instalar o blog direto num VPS com Nginx + systemd.
# Prepara um VPS Ubuntu 22.04/24.04 ou Debian 12 para o blog. Idempotente: pode rodar de novo.
# Uso (como root): bash setup-server.sh <dominio> <email-lets-encrypt>
# Espera os arquivos nginx-blog.conf, nginx-security-headers.conf, blog-api.service e
# backup.sh na mesma pasta (o deploy.sh copia).
set -euo pipefail

DOMAIN="${1:?informe o domínio}"
EMAIL="${2:?informe o e-mail para o certificado HTTPS}"
ROOT="${BLOG_ROOT:-/srv/blog}"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "Rode como root (sudo)."; exit 1; }

echo "==> Pacotes"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q nginx certbot ufw rsync curl ca-certificates gnupg cron
apt-get install -y -q libnginx-mod-http-brotli-filter 2>/dev/null && BROTLI=1 || BROTLI=0

echo "==> Node.js 22"
need_node=1
if command -v node >/dev/null; then
  v="$(node -p 'process.versions.node')"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' && need_node=0 || true
  echo "    node atual: $v"
fi
if [ "$need_node" = 1 ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
node -v

echo "==> Usuário e pastas"
id blog >/dev/null 2>&1 || useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin blog
install -d -o blog -g blog -m 0755 "$ROOT" "$ROOT/app" "$ROOT/content" "$ROOT/content/posts" "$ROOT/uploads" "$ROOT/data" "$ROOT/releases" "$ROOT/backups"
install -d -o root -g blog -m 0750 /etc/blog
install -d -m 0755 /var/www/certbot

echo "==> Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | head -5

echo "==> Nginx"
install -m 0644 "$HERE/nginx-security-headers.conf" /etc/nginx/snippets/blog-security-headers.conf
if [ "$BROTLI" = 1 ]; then
  printf 'brotli on;\nbrotli_comp_level 5;\nbrotli_types text/css text/plain text/xml application/xml application/rss+xml application/json application/javascript image/svg+xml;\n' > /etc/nginx/snippets/blog-brotli.conf
fi
CONF="/etc/nginx/sites-available/blog-$DOMAIN.conf"
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  echo "    certificado ainda não existe: configuração só HTTP para o desafio do Let's Encrypt"
  cat > "$CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 503; }
}
EOF
  ln -sf "$CONF" "/etc/nginx/sites-enabled/blog-$DOMAIN.conf"
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive
fi
sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__ROOT__#$ROOT#g" "$HERE/nginx-blog.conf" > "$CONF"
ln -sf "$CONF" "/etc/nginx/sites-enabled/blog-$DOMAIN.conf"
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
nginx -t && systemctl reload nginx

echo "==> Serviço da API"
sed -e "s#__ROOT__#$ROOT#g" "$HERE/blog-api.service" > /etc/systemd/system/blog-api.service
systemctl daemon-reload
systemctl enable blog-api >/dev/null

echo "==> Backup diário e rebuild diário"
install -m 0755 "$HERE/backup.sh" /usr/local/bin/blog-backup
cat > /etc/cron.d/blog <<EOF
# Backup do conteúdo às 03:30 e rebuild às 04:00 (atualiza cotação e último vídeo)
30 3 * * * blog BLOG_ROOT=$ROOT /usr/local/bin/blog-backup >> $ROOT/backups/backup.log 2>&1
0 4 * * * blog curl -fsS -X POST 'http://127.0.0.1:8787/internal/rebuild?reason=diario' >/dev/null 2>&1
EOF
chmod 0644 /etc/cron.d/blog

echo "==> Pronto. Próximo passo: deploy.sh (na sua máquina)."
