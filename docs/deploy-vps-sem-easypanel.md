# Deploy num VPS sem Easypanel (alternativa)

> **Este não é o caminho principal.** O deploy recomendado é com Docker no Easypanel:
> [deploy-easypanel.md](deploy-easypanel.md). Este guia instala um blog direto no VPS com
> Nginx + systemd, para um servidor sem Easypanel. Ele não foi executado num servidor real.
>
> Mudanças desde a primeira versão: defina `SITE=<pasta do blog em sites/>` no `api.env`
> (passo 7). O servidor também entrega o site estático, mas aqui o Nginx continua servindo
> os arquivos. O agendador interno faz rebuild e backup diários; com ele ligado, o cron do
> passo 14 é opcional (para evitar backup duplicado, use `SCHEDULER=false` no `api.env`).

Guia para instalar o blog num VPS **Ubuntu 22.04/24.04 ou Debian 12**, do zero até
o Wordbee publicando. Todos os comandos são para copiar e colar; os valores que mudam de
um blog para outro ficam em variáveis no passo 0.

Tempo estimado: 40 a 60 minutos.

---

## Visão geral

```
Internet ──HTTPS──► Nginx ─┬─ /                     → /srv/blog/current/   (site estático)
                           ├─ /wp-content/uploads/  → /srv/blog/uploads/   (imagens, na hora)
                           └─ /wp-json/ e /health   → API em 127.0.0.1:8787 (systemd)

API recebe post → grava .md → build em segundo plano → releases/<data>/ → troca o symlink current
```

```
/srv/blog/
  app/                código (git clone); nunca guarda conteúdo
  content/posts/      posts .md gravados pela API      ┐
  uploads/            imagens enviadas                 ├ entram no backup
  data/               estado da API + cache do build   ┘
  releases/<data>/    builds (a API mantém os 3 últimos)
  current             symlink para o release no ar (raiz do Nginx)
  backups/            backups diários (14 dias)
/etc/blog/api.env     segredos e caminhos (só root e o grupo blog leem)
```

---

## 0. Antes de começar

Você precisa de:

- [ ] VPS com Ubuntu 22.04/24.04 ou Debian 12, 1 GB de RAM ou mais (2 GB recomendado) e acesso root por SSH.
- [ ] Domínio (ou subdomínio) com registro DNS **A** apontando para o IP do VPS
      (e **AAAA** se o VPS tiver IPv6). Confira: `dig +short blog.seudominio.com.br` deve mostrar o IP.
- [ ] E-mail para o certificado HTTPS (Let's Encrypt).
- [ ] Endereço do repositório Git do blog.

Ao entrar no servidor, defina as variáveis abaixo **em cada sessão SSH** (os passos usam elas):

```bash
export DOMINIO="blog.seudominio.com.br"      # sem https:// e sem barra
export EMAIL="voce@seudominio.com.br"
export REPO="git@github.com:SUA-CONTA/SEU-REPO.git"
export RAIZ="/srv/blog"
```

---

## 1. Acesso seguro ao servidor

> Pule se o servidor já tem um usuário administrador com `sudo` e login só por chave.

Na **sua máquina**, copie sua chave SSH para o servidor (se ainda não estiver lá):

```bash
ssh-copy-id root@IP_DO_VPS
```

No **servidor**, como root, crie um usuário administrador:

```bash
adduser admin                      # escolha uma senha forte (usada só no sudo)
usermod -aG sudo admin
mkdir -p /home/admin/.ssh
cp /root/.ssh/authorized_keys /home/admin/.ssh/
chown -R admin:admin /home/admin/.ssh
chmod 700 /home/admin/.ssh && chmod 600 /home/admin/.ssh/authorized_keys
```

**Abra outro terminal** e confirme que `ssh admin@IP_DO_VPS` funciona e que `sudo -v` aceita
a senha. Só então desative o login de root e por senha:

```bash
sudo tee /etc/ssh/sshd_config.d/10-endurecimento.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sudo sshd -t && sudo systemctl reload ssh
```

Daqui em diante, use `ssh admin@IP_DO_VPS` e `sudo`.

---

## 2. Sistema e pacotes

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y nginx certbot ufw git rsync curl ca-certificates gnupg cron unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades     # responda "Sim": atualizações de segurança automáticas
```

Opcional, compressão brotli (existe no Ubuntu 24.04; em outras versões pode não existir, e o gzip continua valendo):

```bash
sudo apt-get install -y libnginx-mod-http-brotli-filter && echo "brotli instalado" || echo "sem brotli, segue com gzip"
```

---

## 3. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

Deve listar só `OpenSSH`, `80/tcp` e `443/tcp`. A API (porta 8787) fica fechada para fora:
ela só escuta em `127.0.0.1`.

---

## 4. Node.js 22

```bash
node -v 2>/dev/null || echo "sem node"
```

Se não aparecer `v22.12` ou maior, instale pelo repositório oficial da NodeSource:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt-get update && sudo apt-get install -y nodejs
node -v      # v22.x (precisa ser 22.12 ou maior)
```

---

## 5. Usuário do blog e pastas

O blog roda com um usuário próprio, sem login, dono só de `/srv/blog`:

```bash
sudo useradd --system --home-dir "$RAIZ" --shell /usr/sbin/nologin blog
sudo install -d -o blog -g blog -m 0755 "$RAIZ" "$RAIZ/app" "$RAIZ/content" "$RAIZ/content/posts" \
  "$RAIZ/uploads" "$RAIZ/data" "$RAIZ/releases" "$RAIZ/backups"
sudo install -d -o root -g blog -m 0750 /etc/blog
sudo install -d -m 0755 /var/www/certbot
```

---

## 6. Código

### 6.1 Acesso ao repositório (se for privado)

Crie uma chave **só de leitura** para o servidor:

```bash
sudo -u blog mkdir -p "$RAIZ/.ssh" && sudo chmod 700 "$RAIZ/.ssh"
sudo -u blog ssh-keygen -t ed25519 -N "" -C "deploy $DOMINIO" -f "$RAIZ/.ssh/id_ed25519"
sudo cat "$RAIZ/.ssh/id_ed25519.pub"
```

No GitHub: repositório → **Settings → Deploy keys → Add deploy key**, cole a chave e
**não** marque "Allow write access".

### 6.2 Clonar e instalar dependências

```bash
sudo -u blog -H git clone "$REPO" "$RAIZ/app"     # responda "yes" à pergunta sobre o github.com
cd "$RAIZ/app"
sudo -u blog -H npm ci --omit=dev --no-audit --no-fund
```

> O `npm ci` baixa as versões exatas do `package-lock.json`, incluindo os binários de
> Linux do `sharp` (imagens) e do `pagefind` (busca).

### 6.3 Confira o `site.config.ts`

Ele define nome, cores, categorias etc. O domínio vem da variável `SITE_URL` (passo 7),
então não precisa editar o arquivo só por causa do domínio.

---

## 7. Credenciais e configuração da API

Gere a **senha de aplicação** que o Wordbee vai usar:

```bash
cd "$RAIZ/app"
sudo -u blog node scripts/hash-password.ts
```

A saída tem duas linhas. **Anote a senha** (formato `abcd EFGH ijkl ...`): ela vai para o
Wordbee e não fica guardada em lugar nenhum. Copie o valor do `WP_APP_PASSWORD_HASH`.

Crie o arquivo de configuração. Troque `COLE_O_HASH_AQUI` pelo hash (mantenha as aspas simples):

```bash
sudo tee /etc/blog/api.env >/dev/null <<EOF
SITE=nome-da-pasta-em-sites
SITE_URL=https://$DOMINIO
WP_USER=wordbee
WP_APP_PASSWORD_HASH='COLE_O_HASH_AQUI'

API_HOST=127.0.0.1
API_PORT=8787
TRUST_PROXY=true
RATE_LIMIT_PER_MINUTE=120
MAX_UPLOAD_MB=15

PROJECT_DIR=$RAIZ/app
CONTENT_DIR=$RAIZ/content/posts
UPLOADS_DIR=$RAIZ/uploads
STATE_FILE=$RAIZ/data/api-state.json
BUILD_CACHE_DIR=$RAIZ/data/build-cache
BACKUP_DIR=$RAIZ/backups
SCHEDULER=false
RELEASES_DIR=$RAIZ/releases
CURRENT_LINK=$RAIZ/current
KEEP_RELEASES=3

BUILD_DEBOUNCE_MS=5000
BUILD_MAX_WAIT_MS=30000
EOF
sudo chown root:blog /etc/blog/api.env
sudo chmod 0640 /etc/blog/api.env
sudo nano /etc/blog/api.env      # cole o hash no lugar de COLE_O_HASH_AQUI
```

> Por que o hash fica entre aspas simples: ele contém `$`, e as aspas impedem que algum
> programa tente interpretá-lo como variável.

---

## 8. Conteúdo inicial (opcional)

Para começar com os 7 posts fictícios de exemplo (bom para conferir o visual):

```bash
cd "$RAIZ/app"
sudo -u blog -H env SITE=nome-da-pasta-em-sites CONTENT_DIR="$RAIZ/content/posts" UPLOADS_DIR="$RAIZ/uploads" npm run seed
```

Para começar vazio, pule este passo. Os exemplos podem ser apagados depois de
`$RAIZ/content/posts/`, seguidos de um rebuild (passo 10).

---

## 9. Serviço da API (systemd)

```bash
sudo tee /etc/systemd/system/blog-api.service >/dev/null <<EOF
[Unit]
Description=Blog: API de publicação (compatível com WordPress)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=blog
Group=blog
WorkingDirectory=$RAIZ/app
EnvironmentFile=/etc/blog/api.env
ExecStart=/usr/bin/node api/main.ts
Restart=always
RestartSec=3
TimeoutStopSec=180
UMask=0022

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$RAIZ
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now blog-api
sleep 2 && curl -s http://127.0.0.1:8787/health; echo
```

Esperado: `{"status":"ok","posts":...,"build":{"state":"idle",...}}`.
Se der erro: `sudo journalctl -u blog-api -n 50 --no-pager`.

---

## 10. Primeiro build

```bash
curl -s -X POST 'http://127.0.0.1:8787/internal/rebuild?reason=instalacao'; echo
sleep 20 && curl -s http://127.0.0.1:8787/health; echo
ls -l "$RAIZ/current"
```

No `/health`, `lastBuild.ok` deve ser `true`, e `current` deve apontar para uma pasta em
`releases/`. O build leva de 10 a 40 s, conforme o servidor. Se `lastBuild.ok` for `false`,
o campo `error` mostra o motivo.

---

## 11. Nginx e HTTPS

### 11.1 Cabeçalhos de segurança (snippet)

```bash
sudo tee /etc/nginx/snippets/blog-security-headers.conf >/dev/null <<'EOF'
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
EOF
```

Se o brotli foi instalado no passo 2:

```bash
sudo tee /etc/nginx/snippets/blog-brotli.conf >/dev/null <<'EOF'
brotli on;
brotli_comp_level 5;
brotli_types text/css text/plain text/xml application/xml application/rss+xml application/json application/javascript image/svg+xml;
EOF
```

### 11.2 Configuração provisória (só HTTP) para emitir o certificado

```bash
sudo tee /etc/nginx/sites-available/blog.conf >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMINIO;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 503; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/blog.conf /etc/nginx/sites-enabled/blog.conf
sudo nginx -t && sudo systemctl reload nginx
```

> Se este VPS só vai servir o blog, remova o site padrão: `sudo rm -f /etc/nginx/sites-enabled/default`.
> Se já há outros sites no Nginx, não mexa neles: o blog só responde pelo próprio domínio.

### 11.3 Certificado

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d "$DOMINIO" --email "$EMAIL" --agree-tos --non-interactive
sudo install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo certbot renew --dry-run
```

A renovação é automática (timer do certbot); o hook recarrega o Nginx após renovar.

### 11.4 Configuração definitiva

O modelo está no repositório, em `deploy/nginx-blog.conf`. Este comando troca os marcadores
pelo seu domínio e pela pasta do blog:

```bash
sed -e "s#__DOMAIN__#$DOMINIO#g" -e "s#__ROOT__#$RAIZ#g" "$RAIZ/app/deploy/nginx-blog.conf" \
  | sudo tee /etc/nginx/sites-available/blog.conf >/dev/null
sudo nginx -t && sudo systemctl reload nginx
```

O que essa configuração faz:

| Caminho | Comportamento |
|---|---|
| `http://` | Redireciona para `https://` |
| `/` | Arquivos de `/srv/blog/current`; HTML sempre revalidado (posts novos aparecem na hora) |
| `/wp-content/uploads/` | Imagens direto de `/srv/blog/uploads` (abrem antes do build), cache de 1 ano; os `.json` de metadados ficam ocultos |
| `/_astro/`, `/fonts/` | Cache de 1 ano (nomes versionados) |
| `/wp-json/` | Proxy para a API, até 16 MB por envio, sem cache |
| `/health` | Proxy para a API |
| `/feed/` | Redireciona para `/feed.xml` (endereço antigo do WordPress) |
| `/wp-admin`, `/wp-login.php`, `/xmlrpc.php`, arquivos ocultos | 404 |

---

## 12. Testes

Na sua máquina ou no servidor:

```bash
curl -sI "https://$DOMINIO/" | head -1                       # HTTP/2 200
curl -s  "https://$DOMINIO/health"; echo                     # status ok
curl -sI "https://$DOMINIO/sitemap.xml" | head -1            # 200
curl -s -o /dev/null -w "%{http_code}\n" "https://$DOMINIO/wp-json/wp/v2/users/me"   # 401 (sem senha, correto)
curl -s -u "wordbee:SUA SENHA DE APLICACAO" "https://$DOMINIO/wp-json/wp/v2/users/me"; echo   # roles: administrator
curl -s "https://$DOMINIO/wp-json/wp/v2/categories"; echo    # suas categorias
```

Teste completo, simulando o Wordbee (na **sua máquina**, na pasta do projeto):

```bash
node scripts/simulate-wordbee.ts "https://$DOMINIO" wordbee "SUA SENHA DE APLICACAO"
```

Ele faz o teste de conexão, envia uma imagem, cria um post, repete o envio (não pode
duplicar) e mede o tempo até a página entrar no ar. Apague o post de teste depois
(veja "Apagar um post" na seção 15).

---

## 13. Cadastrar no Wordbee

No Wordbee: **Sites WordPress → Adicionar**

| Campo | Valor |
|---|---|
| Nome | o nome do blog |
| URL | `https://blog.seudominio.com.br` |
| Usuário | `wordbee` |
| Senha de aplicação | a senha gerada no passo 7 |

Clique em **Testar conexão**: deve passar. As categorias do `site.config.ts` aparecem no
cadastro de artigo e nas linhas de produção.

---

## 14. Backup e rebuild diário

```bash
sudo install -m 0755 "$RAIZ/app/deploy/backup.sh" /usr/local/bin/blog-backup
sudo tee /etc/cron.d/blog >/dev/null <<EOF
# Backup às 03:30 e rebuild às 04:00 (atualiza cotação e último vídeo)
30 3 * * * blog BLOG_ROOT=$RAIZ /usr/local/bin/blog-backup >> $RAIZ/backups/backup.log 2>&1
0 4 * * * blog curl -fsS -X POST 'http://127.0.0.1:8787/internal/rebuild?reason=diario' >/dev/null 2>&1
EOF
sudo chmod 0644 /etc/cron.d/blog
sudo -u blog BLOG_ROOT="$RAIZ" /usr/local/bin/blog-backup     # testa agora
ls -lh "$RAIZ/backups"
```

O backup guarda `content/`, `uploads/` e `data/` e mantém 14 dias. **Recomendado:** uma
cópia fora do servidor. Instale e configure o `rclone` (`sudo apt-get install -y rclone`,
`sudo -u blog rclone config`) e acrescente `BACKUP_REMOTE=destino:pasta` antes de
`/usr/local/bin/blog-backup` na linha do cron.

---

## 15. Operação do dia a dia

### Atualizar o código

```bash
cd /srv/blog/app
sudo -u blog -H git pull
sudo -u blog -H npm ci --omit=dev --no-audit --no-fund
sudo systemctl restart blog-api
curl -s -X POST 'http://127.0.0.1:8787/internal/rebuild?reason=deploy'; echo
```

Posts, imagens e estado não são afetados (ficam fora de `app/`). O site fica no ar durante
todo o processo.

### Ver o estado e os logs

```bash
curl -s http://127.0.0.1:8787/health; echo
sudo journalctl -u blog-api -f                 # logs em JSON: posts recebidos, builds, erros
```

### Forçar um build

```bash
curl -s -X POST 'http://127.0.0.1:8787/internal/rebuild?reason=manual'; echo
```

### Apagar um post

A v1 não tem exclusão pela API. No servidor:

```bash
sudo rm /srv/blog/content/posts/SLUG-DO-POST.md
curl -s -X POST 'http://127.0.0.1:8787/internal/rebuild?reason=remocao'; echo
```

### Voltar para o build anterior

```bash
ls /srv/blog/releases/
sudo -u blog ln -sfn /srv/blog/releases/NOME-DO-ANTERIOR /srv/blog/current.tmp
sudo -u blog mv -T /srv/blog/current.tmp /srv/blog/current
```

### Trocar a senha do Wordbee

```bash
cd /srv/blog/app && sudo -u blog node scripts/hash-password.ts
sudo nano /etc/blog/api.env                  # substitua o WP_APP_PASSWORD_HASH
sudo systemctl restart blog-api
```

Depois, atualize a senha no cadastro do site no Wordbee.

### Restaurar um backup

```bash
sudo systemctl stop blog-api
sudo tar -C /srv/blog -xzf /srv/blog/backups/blog-AAAAMMDD-HHMMSS.tar.gz
sudo chown -R blog:blog /srv/blog/content /srv/blog/uploads /srv/blog/data
sudo systemctl start blog-api
curl -s -X POST 'http://127.0.0.1:8787/internal/rebuild?reason=restauracao'; echo
```

---

## 16. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Wordbee: "URL inválida ou apontando para endereço não permitido" | DNS do domínio aponta para IP privado, ou ainda não propagou | `dig +short $DOMINIO` precisa mostrar o IP público do VPS |
| Wordbee: "A REST API do WordPress não foi encontrada" (404) | Nginx sem o bloco `/wp-json/` ou URL cadastrada errada | Passo 11.4; confira a URL sem barra no fim |
| Wordbee: "Usuário ou senha de aplicação inválidos" (401) | Senha ou hash errados | Passo "Trocar a senha" |
| 429 no teste de conexão | 10 senhas erradas seguidas bloqueiam o IP por 15 min | Espere ou reinicie a API (`sudo systemctl restart blog-api`) |
| Post criado, mas a página não aparece | Build falhou | `curl -s http://127.0.0.1:8787/health` mostra `lastBuild.error`; logs com `journalctl` |
| `413` ao enviar imagem | Imagem maior que o limite | Aumente `MAX_UPLOAD_MB` no `api.env` (e `client_max_body_size` no Nginx) |
| `certbot` falha | Porta 80 fechada ou DNS errado | `sudo ufw status`; `dig +short $DOMINIO` |
| Build lento ou morto por falta de memória | VPS com 1 GB | Crie swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' \| sudo tee -a /etc/fstab` |

---

## 17. Checklist final

- [ ] `https://DOMINIO/` abre com cadeado, e `http://` redireciona
- [ ] `/health` mostra `status: ok` e `lastBuild.ok: true`
- [ ] Teste de conexão no Wordbee passa e mostra as categorias
- [ ] Simulação (`simulate-wordbee.ts`): imagem abre na hora, retry não duplica, página no ar em menos de 2 min
- [ ] `/sitemap.xml`, `/feed.xml` e `/robots.txt` abrem
- [ ] Backup gerado em `/srv/blog/backups/`
- [ ] `sudo ufw status` mostra só SSH, 80 e 443
- [ ] Login de root e por senha desativados no SSH
