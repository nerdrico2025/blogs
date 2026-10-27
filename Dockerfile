# Imagem única para todos os blogs. O blog é escolhido por SITE (pasta sites/<SITE>/) e SITE_URL.
# Um volume por blog em /data guarda posts, imagens, estado, releases e backups.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    TRUST_PROXY=1 \
    SITE=exemplo \
    CONTENT_DIR=/data/content/posts \
    UPLOADS_DIR=/data/uploads \
    STATE_FILE=/data/data/api-state.json \
    BUILD_CACHE_DIR=/data/data/build-cache \
    RELEASES_DIR=/data/releases \
    CURRENT_LINK=/data/current \
    BACKUP_DIR=/data/backups \
    SHARP_CONCURRENCY=1 \
    BUILD_MAX_OLD_SPACE_MB=768 \
    ASTRO_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
# O build do Astro escreve em /app/.astro e node_modules/.astro (cache); a pasta precisa ser do usuário node
RUN chown node:node /app
VOLUME ["/data"]
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "api/main.ts"]
