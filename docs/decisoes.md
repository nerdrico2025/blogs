# Decisões

Registro curto das escolhas feitas ao longo das fases, com o motivo.

## Fase 1 (2026-10-26)

| Tema | Decisão | Motivo |
|---|---|---|
| Fonte | **Inter variável self-hosted**, subset latin, woff2, `font-display: swap`, preload | Visual consistente entre sistemas. A referência usa a fonte do sistema. |
| Layout | Container **1140 px**, sidebar **280 px** à esquerda, gap 32 px, conteúdo fluido (~828 px). Colapsa em `≤ 921px` | Com 250 px os widgets da sidebar ficam apertados. Tudo configurável no `site.config.ts`. |
| Ordem no DOM | Conteúdo antes da sidebar; a sidebar vai para a esquerda via CSS Grid | Melhor para acessibilidade e LCP. No mobile a sidebar já fica depois do conteúdo. |
| Integração Wordbee | ~~API WP + patch no `wordbee-clone`~~ → **substituída pela atualização de escopo de 27/10**: só a API WP, **sem nenhuma mudança no Wordbee** | Ver abaixo. |
| Identidade inicial | Blog **fictício de viagem** (nome, domínio e autor inventados) | Trocar depois só no `site.config.ts`. |
| Categorias | Cada categoria tem um **id numérico estável** na config | O Wordbee guarda o id da categoria (`categoriaWpId`). |
| Mídia | Versão otimizada servida na hora em `/wp-content/uploads/AAAA/MM/` (antes `/uploads/`), direto pelo Nginx | O Wordbee usa `source_url` para postar no Facebook antes de qualquer build. |
| Criação de post | Idempotente por slug **e conteúdo** (regra refinada em 27/10, ver abaixo) | O Wordbee reenvia o mesmo POST após timeout. |

## Fase 2 (2026-10-26)

| Tema | Decisão | Motivo |
|---|---|---|
| Versões | Astro 7.3.8, TypeScript 6.0.3, sharp 0.35.5, Node ≥ 22.12, todas fixadas | Versões estáveis com mais de duas semanas. A sharp 0.35.5 corrige uma falha no librsvg. |
| Markdown | Processador `unified` (`@astrojs/markdown-remark`) com um plugin rehype próprio | No Astro 7 o processador padrão (Sätteri) não roda plugins rehype. |
| Inserções no texto | CTA e "Leia também" inseridos antes de um H2 de número configurável, dividindo o HTML no build | Zero JS. Com poucos H2, o CTA vai para o meio do texto e o "Leia também" é omitido. |
| Imagens | `/uploads/...` com `.json` de metadados ao lado; `<picture>` com avif + webp e `width`/`height` sempre | O mesmo formato serve para posts de exemplo e para o que vier da API. |
| Menu mobile | API Popover nativa (`popovertarget`) | Gaveta acessível sem JS. |
| Sumário | `<details open>` | Recolher e expandir sem JS. |
| Barra de progresso de leitura | CSS `animation-timeline: scroll()`; some onde não há suporte | Zero JS. |
| JS na página | Só os relógios do ticker e o botão "copiar link" (scripts inline pequenos) | Meta de INP e de peso. |
| Contraste | Cinzas da referência escurecidos (`#777`→`#666`, `#94a3b8`→`#5f6f84`) | Os originais não passam no WCAG AA (4,5:1). |

Lighthouse mobile local (sem compressão, servidor de preview): home, categoria e
dois artigos com **100/100/100/100**, LCP de 1,3 a 1,6 s e CLS 0.

## Fase 3 (2026-10-27)

| Tema | Decisão | Motivo |
|---|---|---|
| Rotas | Posts e páginas fixas dividem `/<slug>/`; o build falha se houver slug duplicado ou reservado (`src/lib/slugs.ts`) | A API da Fase 4 usa a mesma lista para recusar slugs inválidos. |
| Páginas fixas | Markdown com marcadores `{{site.name}}`, `{{contact.email}}`, `{{legal.owner}}`… | Clonar para outro nicho sem reescrever os textos legais. **Os textos são modelos e precisam de revisão jurídica.** |
| JSON-LD | Um `@graph` por página: `WebSite` (com `SearchAction`), `Organization`, `WebPage`/`CollectionPage`/`AboutPage`/`ContactPage`, `BreadcrumbList`, `Person`, `BlogPosting` e `FAQPage` quando há FAQ | Todas as referências `@id` resolvem dentro do grafo (checado no build de teste). |
| Imagem social | Capa recortada em 1200×630 (`-og.jpg`); sem capa, `public/brand/og-default.jpg` | Formato aceito por todas as redes. |
| Sitemap | `/sitemap.xml` próprio, com `lastmod` e `image:image`; sem páginas de paginação, busca ou 404 | Controle total do `lastmod`. |
| RSS | `/feed.xml` (20 últimos, resumo + capa) | O redirecionamento de `/feed/` (endereço do WordPress) para `/feed.xml` fica no Nginx (Fase 6). |
| Busca | Pagefind, que indexa só o corpo dos posts (`data-pagefind-body`) e ignora sumário, CTA, relacionados, autor e meta. Roda depois do `astro build` | Sem backend; o JS da busca só carrega em `/search/`. |
| `/search/` e 404 | `noindex, follow` | Por isso a `/search/` fica com SEO 69 no Lighthouse; é intencional. |
| Cookies | Banner próprio (sem plugin), escolha no `localStorage`, painel de preferências em `<dialog>`, reabertura pelo rodapé. Consent Mode v2 do Google | Testado: antes da escolha e depois de "Rejeitar" não sai nenhuma requisição ao Google; "Aceitar" carrega GA e AdSense. |
| Meta do AdSense | `google-adsense-account` fica **no HTML estático**; só o **script** espera o consentimento | A meta não faz requisição nem grava cookie, e o robô de verificação do AdSense pode não executar JS. Se preferir o pedido original (meta só depois do consentimento), é uma linha no `BaseLayout`. |
| Ticker | Cotação USD/EUR da AwesomeAPI no build (cache de 1 h em `.cache/`); falhou, usa o último valor e depois o da config | Como o site é reconstruído a cada publicação, a cotação acompanha. Horários por JS, no fuso de cada cidade. |
| YouTube | Último vídeo pelo RSS público do canal no build (cache de 3 h). Com `channelId` vazio, usa o `fallback` | Sem chave de API. |

Lighthouse mobile local: home, artigo, categoria e `/sobre/` com **100/100/100/100**
(banner de cookies visível); `/search/` 100/100/100/69 (noindex). CLS 0 em todas.

## Atualização de escopo (2026-10-27)

O usuário enviou um contrato de integração confirmado e correções de layout. Onde contradiz o que estava acima, vale esta seção.

| Tema | Antes | Agora |
|---|---|---|
| Mudanças no Wordbee | Patch para enviar meta description, `alt_text` e FAQ | **Nenhuma.** O blog imita a WordPress REST API e o Wordbee o cadastra como site WordPress. |
| Endpoints | 4 obrigatórios + extras (atualizar, apagar, `future`, tags, `/api/publish`) | **Só os 4** que o Wordbee usa. Sem `POST /api/publish`, tags, atualização ou `future` pela API na v1. |
| Respostas | 200 | `POST /media` e `POST /posts` respondem **201**. |
| Idempotência | Mesmo slug devolve o post existente | Mesmo slug **e mesmo conteúdo** → devolve o existente (mesmo `id` e `link`); mesmo slug com conteúdo diferente → cria `slug-2`. |
| Caminho das imagens | `/uploads/AAAA/MM/` | `/wp-content/uploads/AAAA/MM/`, igual ao WordPress. |
| Arquivo original | Convertido para webp | Primeiro foi guardado como chegou e devolvido como `source_url`. **Revisto em 2026-10-31:** o arquivo enviado não é guardado (poderia conter GPS e outros metadados) e o `source_url` é um **JPEG progressivo otimizado** (até 1600 px, qualidade ~80, sem metadados). O WebP não é aceito de forma confiável pela Meta, e a distribuição no Facebook busca a foto por essa URL. O WebP e as variantes continuam sendo usados no HTML do blog. Imagens antigas continuam como estão. |
| Imagem de compartilhamento | - | `og:image` e `twitter:image` sempre em JPEG de 1200 px de largura (ou PNG da marca), nunca WebP/AVIF, pelo mesmo motivo. |
| `<blockquote>` | Só a sintaxe `[!DICA]` virava caixa | O `<blockquote>` comum (o que o Wordbee envia) também vira caixa de destaque. |
| "Leia também" | O 4º artigo mais relacionado | Um artigo **da mesma categoria**, de preferência fora dos 3 relacionados; sem outro post na categoria, não aparece. |
| Linha do card | "autor · data" | "autor / data / categoria", em azul. |

Mantidos de propósito (o texto novo diverge, mas há motivo):

- **Larguras 1140 / 280 px**: o texto novo repete "~1080 / ~250 / ~700", mas o usuário escolheu 1140/280 na Fase 1 depois de ver os números da referência. É uma linha no `site.config.ts` (`theme.layout`).
- **Raios de 14–16 px nos cartões**: o texto fala em 8 a 12 px, mas pede para confirmar no CSS da referência, que usa 14–16 px nos cartões e 8–10 px em botões e imagens.
- **Campo `status` no frontmatter** (`publish`/`draft`/`trash`) em vez de `draft: true`: o efeito é o mesmo, o rascunho fica fora do build público. O valor `future` continua aceito no build, mas a API não o recebe.
- **Navegação Anterior/Próximo e compartilhamento**: o trecho do texto novo sobre o que fica "fora do cartão" chegou cortado. Mantive como estava; só os comentários ficam fora da v1.

## Fase 4 (2026-10-27)

| Tema | Decisão | Motivo |
|---|---|---|
| Runtime | Node 22 rodando TypeScript direto (remoção de tipos nativa), sem etapa de compilação; `erasableSyntaxOnly` no tsconfig | Menos peças no VPS. |
| Servidor | Fastify 5 + `@fastify/rate-limit` (120 req/min por IP), logs JSON (pino) com o cabeçalho `Authorization` mascarado | Leve e com log estruturado pronto. |
| Senha | Hash scrypt no `.env` (`npm run api:password`), comparação em tempo constante (usuário por hash SHA-256, scrypt sempre executado). Aceita a senha com ou sem espaços, como o WP | Só o hash fica no servidor. |
| Força bruta | 10 falhas de login por IP em 15 min → 429 até a janela expirar | Além do rate limit geral. |
| HTML → Markdown | `rehype-sanitize` com allowlist → `rehype-remark` → `remark-gfm`. `<h1>` vira `<h2>`; links sem `href` válido viram texto; `script`/`style`/`iframe`/`on*`/`javascript:` são descartados | O HTML do Wordbee não vem sanitizado. |
| Mídia | Entrada jpg/png/webp validada pelo sharp, não pelo cabeçalho, e convertida para JPEG e webp (a guarda byte a byte do original foi revista em 2026-10-31); até 50 MP; SVG e GIF recusados (415); limite de 15 MB (413); nome de arquivo sanitizado e sem sobrescrever (`-2`) | `source_url` precisa abrir na hora e ser aceito pelo Facebook. |
| Estado | Posts são os próprios `.md`; um JSON pequeno (`STATE_FILE`) guarda contadores e o registro de mídias. Escritas em fila única e atômicas (tmp + rename) | Sem banco. O backup cobre `.md`, uploads e esse JSON. |
| POST repetido | Mesmo slug + mesmo hash → 200 com o post existente | Detalhe na integração. |
| Categoria ausente | Usa a primeira do `site.config.ts` | O WP faria o mesmo com "Sem categoria". |
| `status` | `publish` publica; `draft`, `pending` e `private` viram rascunho; `future` → 400 | Fora da v1. |
| Build | Fila com debounce de 5 s (máx. 30 s), build em `releases/<data>` + Pagefind + troca atômica do symlink `current`; mantém 3 releases; até 3 novas tentativas (2/4/8 min) após falha | Sem downtime e sem build dentro da requisição. |

Validação:
- 27 testes automáticos (`npm test`).
- Teste de ponta a ponta local com o simulador do Wordbee, numa cópia isolada:
  - imagem de 4,2 MB → 201 em 0,8 s, com o `source_url` abrindo antes do build;
  - post → 201 em 36 ms, e o retry devolveu o mesmo id;
  - página no ar **11 s** depois da resposta, com sumário, CTA, FAQPage, sitemap, feed e busca atualizados.
- 3 posts seguidos geraram 1 build.
- Um build com erro manteve o site no ar no release anterior; o post publicado nesse meio-tempo entrou no build seguinte.

## Repositório único e Easypanel (2026-10-27)

| Tema | Decisão | Motivo |
|---|---|---|
| Repositório | Um repositório (`nerdrico2025/blogs`) para todos os blogs; cada blog em `sites/<nome>/` (config, marca, páginas fixas, redirects), escolhido por `SITE` | Correções chegam a todos os blogs com um deploy. |
| Dados | Fora do git: `/data` no container, `.local/<SITE>/` em desenvolvimento. Os posts de exemplo viraram fixture (`sites/exemplo/sample-content/`, `npm run seed`) | Deploy de código nunca toca no conteúdo. |
| Quem serve o site no container | O próprio Node (Fastify + `@fastify/static`): site, imagens e API num processo e numa porta (8080). Sem Nginx dentro do container | Um processo só, sem supervisor; o TLS fica no Traefik e o cache pesado na Cloudflare. O HTML e os assets saem pré-comprimidos do build (brotli 9 + gzip), então servir é só ler arquivo. Testado com `curl -I`: mesma política de cache do antigo Nginx. |
| IP real | `TRUST_PROXY=1` (confia só no Traefik); `CF-Connecting-IP` aceito só quando a conexão vem de faixa da Cloudflare | Impede forjar IP para escapar do rate limit. |
| Rate limit | Só nas rotas `/wp-json/` | O site estático não entra na conta. |
| Build no volume | Build numa pasta do container → cópia para `releases/<data>.partial` → rename → symlink | O Astro move arquivos com `rename`, que falha entre o disco do container e o volume (EXDEV, achado no teste com Docker). |
| Agendador | Rebuild e backup diários dentro da API, no minuto `hash(SITE) % 60` | Sem cron no host; os blogs não rodam juntos. |
| Backup S3 | AWS SigV4 próprio (sem SDK), upload em streaming. Testado contra o vetor oficial da AWS e contra um S3 de teste (SeaweedFS) com verificação de assinatura: 200 com a chave certa, 403 com a errada | Evita o SDK da AWS (pesado) para um único PUT. |
| Usuário no container | O entrypoint prepara `/data` como root e roda o servidor como `node` (uid 1000) com `setpriv`; scripts de console (`seed`, `backup`) também trocam para `node` | Volume novo do Easypanel vem como root; arquivos criados pelo console como root travariam a API. |
| Hash da senha | Formato `scrypt:...` (sem `$`); o antigo `scrypt$...` continua aceito | `$` em variáveis de ambiente pode ser interpretado pelo Docker ou pelo Easypanel. |
| Memória | Pico medido de um build completo: ~460 MB (processo Astro, 500 posts, macOS) e ~570 MB no container Linux com 1 GB de limite (inclui cache de disco). API em repouso: ~120 MB | Abaixo de 1 GB, então `GLOBAL_BUILD_SLOTS=2` por padrão; limite de 1 GB por serviço. |
| Trava global | Vagas `slot-N.lock` criadas com `O_EXCL` numa pasta compartilhada do host, heartbeat por mtime a cada 30 s, retomada após 10 min sem heartbeat, espera com jitter de 5–15 s | Testado entre dois containers com 1 vaga: o segundo esperou e entrou em seguida. |
| Migração | `sites/<nome>/redirects.txt` (301) + redirecionamento automático de links com data do WordPress (`/AAAA/MM/slug/` → `/slug/`) | Trocar o domínio sem perder links. |
| `new-site` | Copia o exemplo, troca nome, domínio e autor, gera marca provisória e deixa desligados os blocos que apontam para links de exemplo (banners, newsletter, vídeo, clube, CTA) | Nenhum link falso vai ao ar num blog novo. |

## Painel, anúncios e assistente (2026-10-31)

| Tema | Decisão | Motivo |
|---|---|---|
| Onde ficam as configurações | `/data/settings.json` por cima do `site.config.ts`; campo vazio usa o config | O `asasdomundo` continua igual sem o arquivo. |
| Trocar slug de categoria | O slug antigo vira `aliases` da categoria e a URL antiga redireciona (301); os arquivos dos posts não são reescritos | Reescrever centenas de arquivos é mais arriscado, e os posts continuam achando a categoria. |
| Código de anúncio e rastreamento | Guardado em atributo (inerte) e ativado no navegador só depois do consentimento | LGPD: nada carrega antes do aceite. Consequência: `document.write` não funciona. |
| Categorias de consentimento | GTM e códigos livres: "Estatísticas"; script da rede e posições: "Publicidade" | Reaproveita as duas categorias que o banner já tinha. |
| Anúncio em rejeição | Espaços somem antes da primeira pintura | Evita caixa vazia para quem rejeitou. |
| Cor de destaque | Etiquetas de categoria e títulos pequenos (`--cor-destaque`) | O motor não tinha essa cor. Sem valor, a aparência fica como antes. |
| Modelo de IA do assistente | `claude-sonnet-5-5` por padrão (`AI_MODEL`), com fallback no servidor em caso de recusa | Escolha do projeto para esta tarefa simples. |
| Modelo dos blogs sem pasta | `sites/_base/`, neutro; as páginas fixas vão para `/data/pages` | Blog novo sem criar pasta no repositório. |
| Senha do painel e do Wordbee | Hash em `/data/secrets.json` (600), que entra no backup; variáveis de ambiente têm prioridade | Blog novo sem terminal, sem quebrar o `asasdomundo`. |
| Sessão do painel | Em memória | Reiniciar pede login de novo, o que é aceitável para um painel de uso raro. |
| Modo "não configurado" | Responde 503 com `Retry-After`, além do noindex | É o sinal correto para buscadores em manutenção. |
