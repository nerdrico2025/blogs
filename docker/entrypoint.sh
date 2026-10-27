#!/bin/sh
# Prepara o volume /data e a pasta da trava global, e roda o servidor como usuário "node" (não-root).
set -eu

if [ "$(id -u)" = "0" ]; then
  for d in "$CONTENT_DIR" "$UPLOADS_DIR" "$(dirname "$STATE_FILE")" "$BUILD_CACHE_DIR" "$RELEASES_DIR" "$BACKUP_DIR"; do
    mkdir -p "$d"
  done
  # Volume novo ou backup restaurado como root: corrige só o que não é do usuário node
  find /data -xdev ! -user node -exec chown -h node:node {} + 2>/dev/null || true
  if [ -n "${GLOBAL_BUILD_LOCK_DIR:-}" ]; then
    mkdir -p "$GLOBAL_BUILD_LOCK_DIR"
    chmod 1777 "$GLOBAL_BUILD_LOCK_DIR"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
