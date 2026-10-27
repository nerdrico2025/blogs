# Deploy no Easypanel: passo a passo

> **Atenção: este guia ainda não foi executado num servidor real.** A imagem Docker foi
> construída e testada localmente (ARM64, no Mac):
> - build da imagem e build do site dentro do container;
> - simulação completa do Wordbee e política de cache conferida com `curl`;
> - trava de build entre dois containers;
> - backup enviado a um servidor S3 de teste.
>
> Não foram testados: o Easypanel em si, a Cloudflare, o Wordbee real e a imagem x86_64 (a
> arquitetura do VPS da Contabo). Os nomes de botões e abas do Easypanel podem variar um
> pouco entre versões. Se algo não bater, anote o que apareceu e me mande.

Cada blog é um **serviço App** no Easypanel, criado a partir do mesmo repositório
(`nerdrico2025/blogs`) e do mesmo `Dockerfile`. O que muda de um blog para outro são as
variáveis de ambiente (`SITE`, `SITE_URL`, senha) e o volume de dados.

```
Visitante ──HTTPS──► Cloudflare (opcional) ──► Traefik do Easypanel ──► container do blog (porta 8080)
                                                                          ├─ /                     site estático (/data/current)
                                                                          ├─ /wp-content/uploads/  imagens (/data/uploads, na hora)
                                                                          └─ /wp-json/, /health    API para o Wordbee
Volume do blog em /data: content/posts, uploads, data, releases, current, backups
Pasta do host /shared/build-locks: trava que limita builds simultâneos no VPS inteiro
```

---

## 1. Antes de começar

Você precisa de:

- [ ] Acesso ao painel do Easypanel (o VPS da Contabo já tem o Easypanel instalado).
- [ ] Acesso SSH ao VPS como root (só para os passos 2.1 e, se quiser, 2.2).
- [ ] Conta no GitHub com acesso ao repositório `nerdrico2025/blogs`.
- [ ] Domínio do blog com o DNS na Cloudflare (passo 5).

**Não faça:**

- Não instale Nginx, Apache, Caddy nem certbot no host. O Traefik do Easypanel já usa as
  portas 80 e 443 e cuida dos certificados.
- Não mexa no firewall do host (ufw/iptables). O Easypanel depende das regras atuais.
- Não use systemd nem cron no host para o blog. Builds, rebuild diário e backup rodam
  dentro do container.
- Não ligue o proxy (nuvem laranja) da Cloudflare antes de o certificado sair (passo 5.4).

---

## 2. Preparação do VPS (uma vez só, para todos os blogs)

### 2.1 Pasta da trava global de build

No VPS, como root:

```bash
mkdir -p /shared/build-locks
chmod 1777 /shared/build-locks
ls -ld /shared/build-locks
```

**Resultado esperado:** `drwxrwxrwt ... /shared/build-locks`.

Para que serve: os blogs montam essa mesma pasta, e nela cada build ocupa uma "vaga". Com
`GLOBAL_BUILD_SLOTS=2`, no máximo dois blogs buildam ao mesmo tempo no VPS inteiro; os
outros esperam a vez. A resposta ao Wordbee nunca espera por isso, só a publicação da
página. Se um container morrer no meio do build, a vaga dele é liberada sozinha depois de
10 minutos.

### 2.2 Swap de 4 GB (opcional, recomendado)

Uma rede de segurança para picos de memória: evita que o kernel mate processos se vários
blogs e os serviços que já existem no Easypanel apertarem ao mesmo tempo.

```bash
swapon --show                      # se já aparecer um swap, pule este passo
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl vm.swappiness=10
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
free -h
```

**Resultado esperado:** `free -h` mostra `Swap: 4.0Gi`.

### 2.3 Acesso do Easypanel ao repositório privado

Há duas opções:

| Opção | Como funciona | Quando usar |
|---|---|---|
| **Token do GitHub (recomendado)** | Um *fine-grained personal access token* com acesso **só a este repositório**, **somente leitura** (Contents: Read-only). Cadastrado uma vez no Easypanel, vale para todos os blogs. | É o mais simples: o Easypanel tem integração nativa com o GitHub e lista os repositórios. |
| Chave de deploy (SSH) | Uma chave só de leitura cadastrada no repositório (Settings → Deploy keys). | Se preferir não ter token. Dá mais trabalho, e cada chave vale para um repositório só. |

Criar o token:

1. GitHub → foto → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner:** `nerdrico2025`. **Repository access:** *Only select repositories* → `blogs`.
3. **Permissions → Repository permissions → Contents: Read-only** (o *Metadata: Read-only* entra sozinho).
4. Validade: 1 ano, com lembrete para renovar.
5. Copie o token.

No Easypanel: **Settings → GitHub** (ou "Git Providers") → cole o token → salvar.

**Resultado esperado:** ao criar um serviço App com a fonte GitHub, o repositório
`nerdrico2025/blogs` aparece na lista.

---

## 3. Criar o primeiro blog no Easypanel

Os exemplos usam `asasdomundo` / `asasdomundo.com.br`. Para outro blog, troque os dois.

### 3.1 Projeto

**Create Project** → nome `blogs` (um projeto para todos os blogs, ou um por blog, como
preferir).

### 3.2 Serviço App

Dentro do projeto: **+ Service → App** → nome `asasdomundo` → criar.

### 3.3 Fonte (Source)

- **GitHub:** owner `nerdrico2025`, repositório `blogs`, branch `main`, build path `/`.
- **Build:** tipo **Dockerfile**, arquivo `Dockerfile`.

Salve. Ainda **não** clique em Deploy.

### 3.4 Senha de aplicação do Wordbee

A senha é gerada uma vez por blog. No Easypanel fica só o **hash**; a senha vai para o Wordbee.
Há duas formas:

- **Na sua máquina** (na pasta do projeto): `npm run api:password`
- **Pelo console de um blog que já está rodando** (aba **Console** do serviço): `npm run api:password`

A saída é assim:

```
Senha de aplicação (cadastre no Wordbee): abcd EFGH ijkl MNOP qrst UVWX
Variável de ambiente (cole no Easypanel ou no .env):
WP_APP_PASSWORD_HASH=scrypt:16384:8:1:...:...
```

Guarde a senha num gerenciador de senhas; ela não fica salva em lugar nenhum. A linha do
hash vai para o próximo passo.

### 3.5 Variáveis de ambiente (aba Environment)

Cole e ajuste:

```env
SITE=asasdomundo
SITE_URL=https://asasdomundo.com.br
WP_USER=wordbee
WP_APP_PASSWORD_HASH=scrypt:16384:8:1:...:...
GLOBAL_BUILD_LOCK_DIR=/shared/build-locks
GLOBAL_BUILD_SLOTS=2
```

Tabela completa (só as quatro primeiras são obrigatórias; as demais têm padrão na imagem):

| Variável | Padrão | Para que serve |
|---|---|---|
| `SITE` | `exemplo` | Pasta do blog em `sites/` |
| `SITE_URL` | domínio da config | Domínio público (`https://...`, sem barra). Use o subdomínio de teste enquanto testa |
| `WP_USER` | (obrigatória) | Usuário que o Wordbee usa (`wordbee`) |
| `WP_APP_PASSWORD_HASH` | (obrigatória) | Hash da senha de aplicação (passo 3.4) |
| `GLOBAL_BUILD_LOCK_DIR` | (desligada) | `/shared/build-locks`; liga a trava global entre os blogs |
| `GLOBAL_BUILD_SLOTS` | `2` | Builds simultâneos no VPS inteiro |
| `BUILD_MAX_OLD_SPACE_MB` | `768` | Heap máximo do processo de build |
| `SHARP_CONCURRENCY` | `1` | Threads do processamento de imagem |
| `PORT` | `8080` | Porta HTTP do container |
| `TRUST_PROXY` | `1` | Proxies confiáveis à frente (o Traefik). O IP real do visitante vem do `X-Forwarded-For`, e do `CF-Connecting-IP` quando a conexão vem da Cloudflare |
| `RATE_LIMIT_PER_MINUTE` | `120` | Limite de requisições por IP na API |
| `MAX_UPLOAD_MB` | `16` | Tamanho máximo de imagem enviada |
| `DAILY_REBUILD_UTC_HOUR` | `7` | Hora (UTC) do rebuild diário (04:00 em Brasília). O minuto é calculado pelo `SITE`, para os blogs não buildarem juntos |
| `DAILY_BACKUP_UTC_HOUR` | `6` | Hora (UTC) do backup diário (03:00 em Brasília), também com minuto por blog |
| `BACKUP_RETENTION_DAYS` | `14` | Dias de backup guardados em `/data/backups` |
| `BACKUP_S3_ENDPOINT` | (desligado) | Ex.: `https://eu2.contabostorage.com` (Object Storage da Contabo) |
| `BACKUP_S3_REGION` | `us-east-1` | Região (a Contabo aceita o padrão) |
| `BACKUP_S3_BUCKET` | (desligado) | Nome do bucket |
| `BACKUP_S3_ACCESS_KEY` / `BACKUP_S3_SECRET_KEY` | (desligado) | Credenciais S3 do bucket |
| `BACKUP_S3_PREFIX` | valor de `SITE` | "Pasta" dentro do bucket |
| `SCHEDULER` | `true` | `false` desliga o rebuild e o backup diários |

> O hash não tem `$`, então pode ser colado sem aspas.

### 3.6 Volumes (aba Mounts)

Dois mounts:

| Tipo | Origem | Destino no container |
|---|---|---|
| **Volume** | nome `asasdomundo-data` (um por blog, **nunca** compartilhado) | `/data` |
| **Bind** | `/shared/build-locks` (a pasta do passo 2.1) | `/shared/build-locks` |

### 3.7 Domínio e porta (aba Domains)

- **Add domain** → `asasdomundo.com.br`, **HTTPS ligado**, porta do container **8080**, caminho `/`.
- (Opcional) `www.asasdomundo.com.br` também apontando para a porta 8080. Se o Easypanel
  oferecer, configure o `www` para redirecionar para o domínio principal.

Enquanto o DNS não estiver apontado (passo 5), o certificado não sai. Isso é normal.

### 3.8 Recursos e deploy (aba Advanced / Resources / Deploy)

- **Memory limit:** `1024` MB (1 GB). Um build descontrolado derruba só este blog, não o VPS.
- **Memory reservation:** deixe vazio ou `150` MB.
- **Zero downtime:** **desligado.** Com ele ligado, o container novo sobe antes do antigo
  parar, e os dois usariam o mesmo volume ao mesmo tempo (dois servidores gravando posts e
  fazendo builds). Desligado, cada deploy de código deixa o blog fora do ar por alguns segundos.
- **Healthcheck:** já vem no `Dockerfile` (`/health` a cada 30 s, 90 s de tolerância na subida).
  Não precisa configurar.

### 3.9 Primeiro deploy

Clique em **Deploy**. Acompanhe a aba de deploy/logs.

**Resultado esperado:**
- A imagem é construída (3 a 6 minutos na primeira vez).
- O container sobe e, nos logs, aparecem `blog no ar` e, logo depois, `build iniciado` e
  `build publicado` (o primeiro release é gerado sozinho).
- O status do serviço fica verde (healthy).

### 3.10 Posts de exemplo (opcional)

Para conferir o visual antes do primeiro post real, abra o **Console** do serviço e rode:

```bash
npm run seed
npm run rebuild
```

Para remover depois: `rm /data/content/posts/*.md && npm run rebuild`. As imagens de
exemplo podem ficar; não aparecem em lugar nenhum.

### 3.11 Auto deploy (opcional; não recomendado com vários blogs)

O Easypanel pode gerar uma **Deploy Webhook URL** por serviço, para cadastrar no GitHub
(repositório → Settings → Webhooks). Com 10 blogs no mesmo repositório, **cada push
reconstruiria os 10 ao mesmo tempo** (10 builds de imagem e 10 reinícios). Prefira o deploy
manual, um blog por vez (passo 9.1).

> Otimização para depois: construir a imagem uma vez só no GitHub Actions, publicar no
> GitHub Container Registry e fazer os 10 serviços usarem essa imagem (fonte "Docker Image").

---

## 4. Memória: quanto cada blog usa

Medido com a imagem deste repositório (Linux, container com 1 GB de limite):

| Situação | Memória |
|---|---|
| Blog em repouso (servidor + API) | **~120 MB** (RSS do processo) |
| Build completo com 7 posts | ~1,5 s |
| Build completo com **500 posts** (614 páginas, com busca e compressão) | **pico de ~570 MB** no container, 7,2 s |
| Upload de imagem de 4 MB + build | pico de ~650 MB no container |

O pico do container inclui o cache de disco, que o kernel devolve quando precisa. O pico
do processo de build (Astro) foi de ~460 MB.

**Conta para 10 blogs**, com no máximo 2 builds simultâneos (`GLOBAL_BUILD_SLOTS=2`):

```
10 blogs × ~150 MB (repouso, com folga)     ≈ 1,5 GB
 2 builds × ~0,7 GB (pico, com folga)       ≈ 1,4 GB
                                    total   ≈ 2,9 GB   (cabe nos ~5 GB livres do VPS)
```

O limite de 1 GB por serviço é um teto, não uma reserva: os 10 blogs não ocupam 10 GB.

Se o VPS ficar apertado (`free -h` mostrando pouca memória disponível e swap crescendo),
reduza para `GLOBAL_BUILD_SLOTS=1` em todos os blogs. As publicações continuam funcionando,
só a página demora um pouco mais para aparecer quando vários blogs publicam juntos.

**Subida gradual recomendada:** coloque **1 blog**, observe por alguns dias (memória no
painel do Easypanel, `free -h` no host, `/health` e as publicações do Wordbee), e depois
adicione os outros em lotes de 2 a 3.

---

## 5. Cloudflare (por domínio)

### 5.1 Adicionar o site

Cloudflare → **Add a domain** → `asasdomundo.com.br` → plano Free → continuar.

### 5.2 Trocar os nameservers no registrador

A Cloudflare mostra dois nameservers (ex.: `xxx.ns.cloudflare.com`). No registrador do
domínio (Registro.br, GoDaddy etc.), troque os nameservers pelos dois da Cloudflare.

**Resultado esperado:** em algumas horas (até 24 h), a Cloudflare marca o domínio como **Active**.

> Se o domínio já tem um site no ar, leia antes a seção 6.

### 5.3 Registros DNS

**DNS → Records**:

| Tipo | Nome | Conteúdo | Proxy |
|---|---|---|---|
| A | `@` | IP do VPS | **Somente DNS (nuvem cinza)** |
| A | `www` | IP do VPS | **Somente DNS (nuvem cinza)** |

Apague registros A/AAAA antigos do mesmo nome que apontem para outro servidor. Não mexa
em registros MX e TXT de e-mail.

### 5.4 Esperar o certificado

Com a nuvem cinza, o Traefik do Easypanel emite o certificado Let's Encrypt sozinho.

**Teste:** `curl -sI https://asasdomundo.com.br/ | head -1` deve responder `HTTP/2 200`.

### 5.5 Ligar o proxy da Cloudflare (opcional, recomendado)

Só depois de o HTTPS funcionar com a nuvem cinza:

1. **SSL/TLS → Overview → modo Full (strict).** O Traefik tem certificado válido, então o
   modo estrito funciona e protege o trecho Cloudflare → VPS. Nunca use "Flexible", que causa
   loop de redirecionamento.
2. **DNS:** troque `@` e `www` para **Proxied (nuvem laranja)**.
3. **Security → Bots:** **desligue o Bot Fight Mode.** Ele bloqueia clientes que não são
   navegadores, como o Wordbee, e no plano Free **não pode ser contornado por regra**. O
   sintoma é o teste de conexão do Wordbee falhar com 403 ("Acesso negado... firewall/WAF").
4. **Security → WAF → Custom rules → Create rule** "Liberar API do Wordbee":
   - *When incoming requests match:* `URI Path` **starts with** `/wp-json/`
   - *Then:* **Skip**, marcando todas as opções disponíveis (regras personalizadas restantes,
     rate limiting, regras gerenciadas e Super Bot Fight Mode, se existir no plano).
5. **Caching → Cache Rules → Create rule** "API sem cache": `URI Path` starts with
   `/wp-json/` **or** `URI Path` equals `/health` → **Bypass cache**.

O blog já lê o IP real do visitante pelo `CF-Connecting-IP`, aceitando esse cabeçalho só
quando a conexão vem de um IP da Cloudflare.

**Teste depois de ligar:** o teste de conexão do Wordbee (passo 7.2) tem que continuar passando.

---

## 6. Migrando um domínio que já tem site no ar

Para não derrubar o site atual enquanto testa:

1. **Teste num subdomínio.** Crie na Cloudflare (ou no DNS atual) `novo.asasdomundo.com.br`
   → A → IP do VPS (nuvem cinza). No serviço do Easypanel, use o domínio
   `novo.asasdomundo.com.br` e `SITE_URL=https://novo.asasdomundo.com.br`.
2. Cadastre esse endereço no Wordbee como um site à parte e publique alguns posts de teste.
3. **Mapeie as URLs antigas.** Liste as URLs do site atual (sitemap antigo ou Google Search
   Console) e compare com as novas:
   - `/slug-do-post/` igual nos dois: nada a fazer.
   - Links antigos com data, como `/2024/05/slug/`: o blog já redireciona sozinho para
     `/slug/` quando o post existe.
   - Demais casos: adicione linhas em `sites/asasdomundo/redirects.txt`, no formato
     `/caminho-antigo/ /caminho-novo/`, faça commit e deploy. Viram redirecionamentos 301.
   - Imagens antigas em `/wp-content/uploads/...`: se quiser manter os links, copie a pasta
     `uploads` do site antigo para o volume (`/data/uploads`), com a mesma estrutura de
     ano/mês. Os arquivos novos nunca sobrescrevem os antigos (nomes repetidos ganham `-2`).
4. **Virada:** no Easypanel, adicione o domínio principal (e o `www`) ao serviço e mude
   `SITE_URL=https://asasdomundo.com.br` → Deploy. No DNS, aponte `@` e `www` para o IP do
   VPS (nuvem cinza até o certificado sair).
5. No Wordbee, edite o site para a URL principal, ou cadastre-o de novo.
6. Envie o novo `https://asasdomundo.com.br/sitemap.xml` no Google Search Console.
7. Depois de uns dias estável, remova o subdomínio `novo.`.

---

## 7. Testes

### 7.1 Com `curl` (de qualquer máquina)

```bash
D=https://asasdomundo.com.br
curl -sI $D/ | grep -iE "^HTTP|cache-control|strict-transport"     # 200, max-age=0, HSTS
curl -s  $D/health; echo                                              # "status":"ok", "lastBuild":{"ok":true...
curl -sI $D/sitemap.xml | head -1                                     # 200
curl -sI $D/feed/ | grep -i location                                  # /feed.xml
curl -s -o /dev/null -w "%{http_code}\n" $D/wp-json/wp/v2/users/me    # 401 (sem senha: correto)
curl -s -u "wordbee:SUA SENHA" $D/wp-json/wp/v2/users/me; echo        # "roles":["administrator"]
curl -s $D/wp-json/wp/v2/categories; echo                             # suas categorias
```

### 7.2 Simulando o Wordbee (na sua máquina, na pasta do projeto)

```bash
node scripts/simulate-wordbee.ts https://asasdomundo.com.br wordbee "SUA SENHA"
```

**Resultado esperado:** 200 no teste de conexão, 201 na imagem (com a URL abrindo na hora),
201 no post, o retry devolvendo o **mesmo id** e "página no ar em X s" com X menor que 120.

Depois, apague o post de teste (passo 9.3).

### 7.3 Cadastro no Wordbee

No Wordbee: **Sites WordPress → Adicionar**

| Campo | Valor |
|---|---|
| Nome | Asas do Mundo |
| URL | `https://asasdomundo.com.br` |
| Usuário | `wordbee` |
| Senha de aplicação | a senha do passo 3.4 |

**Testar conexão** → deve passar. As categorias do `site.config.ts` aparecem no cadastro de
artigos e nas linhas de produção.

---

## 8. Receita para adicionar um novo blog

Repita para cada blog (de preferência em lotes de 2 a 3, observando a memória entre um lote e outro):

1. Na sua máquina: `npm run new-site -- <nome> --name "Nome do Blog" --domain dominio.com.br`
2. Revise `sites/<nome>/site.config.ts`: categorias (ids fixos), autor, redes sociais e os itens marcados com TODO.
3. Troque a marca provisória em `sites/<nome>/public/brand/` (logo, favicon, `og-default.jpg`, `logo-512.png`) e revise `sites/<nome>/pages/`.
4. Teste local: `SITE=<nome> npm run seed && SITE=<nome> npm run dev` → abra http://localhost:4321.
5. `git add sites/<nome> && git commit -m "Adiciona o blog <nome>" && git push`
6. Gere a senha de aplicação e o hash (`npm run api:password`) e guarde a senha.
7. Easypanel: novo serviço App (passos 3.2 a 3.8) com `SITE=<nome>`, `SITE_URL`, `WP_USER`, `WP_APP_PASSWORD_HASH`, `GLOBAL_BUILD_LOCK_DIR`, volume `<nome>-data` em `/data`, bind `/shared/build-locks`, domínio na porta 8080, 1 GB, zero downtime desligado → Deploy.
8. Cloudflare: adicionar domínio, nameservers, registros A cinza → esperar o HTTPS → (opcional) proxy laranja com Full (strict), Bot Fight Mode desligado e regra de Skip para `/wp-json/` (seção 5).
9. Testes: `curl` da seção 7.1 e `simulate-wordbee.ts` (7.2); apague o post de teste.
10. Wordbee: cadastrar o site (7.3), testar conexão e publicar o primeiro artigo real.

---

## 9. Operação do dia a dia

### 9.1 Atualizar o código (um blog por vez)

1. Envie as mudanças para o GitHub (`git push`).
2. No Easypanel, abra **um** blog → **Deploy**. Espere ficar verde e confira `https://dominio/health`.
3. Repita para o próximo. Não faça o deploy de todos ao mesmo tempo: cada deploy constrói a
   imagem e gera um build do site.

Posts, imagens e estado ficam no volume e não são afetados.

### 9.2 Logs e estado

- **Logs:** aba **Logs** do serviço (JSON: posts recebidos, builds, backups, erros).
- **Estado:** `https://dominio/health` mostra os posts, o estado do build (`idle`, `waiting`,
  `waiting-slot` esperando vaga, `building`) e o último build (`ok`, duração, erro).

### 9.3 Apagar um post

Console do serviço:

```bash
ls /data/content/posts/
rm /data/content/posts/SLUG-DO-POST.md
npm run rebuild
```

### 9.4 Forçar um build

Console: `npm run rebuild`.

### 9.5 Voltar para o build anterior

Console:

```bash
ls /data/releases/
ln -sfn /data/releases/NOME-DO-ANTERIOR /data/current.tmp && mv -T /data/current.tmp /data/current
```

O próximo build (novo post ou rebuild diário) publica de novo a versão atual do conteúdo.

### 9.6 Trocar a senha do Wordbee

1. `npm run api:password` (na sua máquina ou no console).
2. Easypanel → Environment → troque `WP_APP_PASSWORD_HASH` → salvar → Deploy.
3. Wordbee → edite o site → nova senha → Testar conexão.

### 9.7 Backup e restauração

- Automático todo dia: `/data/backups/blog-<site>-<data>.tar.gz` (14 dias) e, se configurado, no S3.
- Backup na hora: console → `npm run backup`.
- **Restaurar:** no console,

```bash
ls /data/backups/
cd /data && tar -xzf backups/blog-<site>-<data>.tar.gz     # recria content/, uploads/ e data/
```

Depois, **reinicie o serviço** no Easypanel. O container corrige o dono dos arquivos
restaurados e publica um build novo.

Para restaurar a partir do S3, baixe o arquivo do bucket (painel da Contabo), envie para o
VPS e copie para o volume. Ao reiniciar, o container corrige as permissões sozinho.

> No Object Storage, configure uma regra de expiração (*lifecycle*) no bucket para apagar
> backups antigos: o blog só apaga as cópias locais.

---

## 10. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Wordbee: "Acesso negado pelo site (firewall/WAF)" (403) | Bot Fight Mode ou regra WAF da Cloudflare | Desligue o Bot Fight Mode e crie a regra de Skip para `/wp-json/` (5.5) |
| Wordbee: "URL inválida ou apontando para endereço não permitido" | DNS não resolve ou aponta para IP privado | Confira o registro A; `dig +short dominio` |
| Wordbee: "REST API não encontrada" (404) | URL cadastrada errada, ou domínio não ligado ao serviço | Confira a aba Domains e a URL (sem barra no fim) |
| Wordbee: "Usuário ou senha inválidos" (401) | Hash ou senha não conferem | Gere de novo (9.6) |
| 429 no teste de conexão | 10 senhas erradas seguidas bloqueiam o IP por 15 min | Espere ou reinicie o serviço |
| Página do post não aparece | Build falhou ou esperando vaga | `/health`: `lastBuild.error` ou `state: waiting-slot`; veja os logs |
| `state: waiting-slot` por muito tempo | Outros blogs buildando, ou vaga presa de um container morto | Libera sozinha em até 10 min; no host: `ls -la /shared/build-locks` |
| HTTPS não sai | DNS com nuvem laranja antes do certificado, ou DNS ainda propagando | Nuvem cinza até o certificado sair (5.4) |
| Loop de redirecionamento com a Cloudflare | SSL em modo Flexible | Use Full (strict) |
| Serviço reiniciando sozinho | Memória acima de 1 GB (OOM) | Logs do Easypanel; reduza `GLOBAL_BUILD_SLOTS` ou aumente o limite desse blog |
| Erro de permissão em `/data` | Arquivos criados por root pelo console | Reinicie o serviço: o container corrige o dono dos arquivos ao subir |
| "Imagem inválida ou formato não suportado" (415) | Arquivo que não é JPG, PNG ou WebP | O Wordbee envia JPG ou PNG; verifique o provedor de imagem |

---

## 11. Checklist final (por blog)

- [ ] `https://dominio/` abre com cadeado; `http://` redireciona para `https://`
- [ ] `/health` com `status: ok` e `lastBuild.ok: true`
- [ ] Teste de conexão do Wordbee passa e mostra as categorias
- [ ] `simulate-wordbee.ts`: imagem abre na hora, retry não duplica, página no ar em menos de 2 min
- [ ] `/sitemap.xml`, `/feed.xml` e `/robots.txt` abrem
- [ ] Limite de memória de 1 GB e zero downtime desligado no serviço
- [ ] Volume próprio em `/data` e bind `/shared/build-locks`
- [ ] Backup aparece em `/data/backups` no dia seguinte (e no S3, se configurado)
- [ ] Com a Cloudflare laranja: Full (strict), Bot Fight Mode desligado, regra de Skip para `/wp-json/`
