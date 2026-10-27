#!/usr/bin/env bash
# ALTERNATIVA SEM EASYPANEL: o caminho principal é o Docker no Easypanel (docs/deploy-easypanel.md).
# Este arquivo só serve para instalar o blog direto num VPS com Nginx + systemd.
# Backup diário do conteúdo: posts, imagens e estado da API. Mantém 14 dias.
# Para cópia fora do servidor, configure BACKUP_REMOTE (destino do rclone, ex.: "b2:meu-bucket/blog").
set -euo pipefail
ROOT="${BLOG_ROOT:-/srv/blog}"
DEST="$ROOT/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
tar -C "$ROOT" -czf "$DEST/blog-$STAMP.tar.gz.partial" content uploads data
mv "$DEST/blog-$STAMP.tar.gz.partial" "$DEST/blog-$STAMP.tar.gz"
find "$DEST" -name 'blog-*.tar.gz' -mtime +14 -delete
if [ -n "${BACKUP_REMOTE:-}" ] && command -v rclone >/dev/null; then
  rclone copy "$DEST/blog-$STAMP.tar.gz" "$BACKUP_REMOTE"
fi
echo "backup ok: $DEST/blog-$STAMP.tar.gz"
