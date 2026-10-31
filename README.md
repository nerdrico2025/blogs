# Blogs estáticos alimentados pelo Wordbee

Um motor único (Astro + API em Node) para vários blogs rápidos, sem WordPress e sem painel.
O conteúdo chega pelo app **Wordbee**, que trata cada blog como um site WordPress: o blog
imita os 4 endpoints da WordPress REST API que o Wordbee usa.

- **Deploy (principal):** Docker no Easypanel → [docs/deploy-easypanel.md](docs/deploy-easypanel.md)
- Alternativa sem Easypanel (Nginx + systemd) → [docs/deploy-vps-sem-easypanel.md](docs/deploy-vps-sem-easypanel.md)
- Integração com o Wordbee → [docs/wordbee-integracao.md](docs/wordbee-integracao.md)
- Decisões de projeto → [docs/decisoes.md](docs/decisoes.md)

## Estrutura

```
sites/<nome>/            um por blog (escolhido pela variável SITE)
  site.config.ts         nome, cores, categorias (ids fixos), autor, sidebar, CTA, rodapé…
  public/brand/          logo, favicon, imagens de compartilhamento, banners
  pages/                 páginas fixas (Sobre, Contato, textos legais) com {{marcadores}}
  redirects.txt          301 de URLs antigas (migração)
sites/exemplo/           blog fictício de demonstração e modelo do `new-site`
  sample-content/posts/  posts de exemplo (copiados por `npm run seed`)
src/                     motor do site (componentes, layout, SEO, Markdown)
api/                     servidor: API do Wordbee, site estático, builds, agendador, backup
shared/settings.ts       configurações do /admin por cima do site.config.ts
shared/media.ts          processamento de imagens (JPEG e webp até 1600 px, variantes de 160, 480, 800 e 1200 px)
scripts/                 new-site, seed, rebuild, backup, api:password, simulate-wordbee
Dockerfile               imagem única para todos os blogs
deploy/                  alternativa sem Easypanel (Nginx, systemd, scripts)
```

Posts, imagens e estado **não ficam no git**. Em produção ficam no volume `/data` de cada
blog; em desenvolvimento, em `.local/<SITE>/`.

## Comandos

```bash
npm install
SITE=exemplo npm run seed         # copia os posts de exemplo e gera as imagens em .local/exemplo/
SITE=exemplo npm run dev          # http://localhost:4321
SITE=exemplo npm run build        # gera dist/ e o índice de busca
npm run check                     # checagem de tipos
npm test                          # testes (API, servidor estático, trava, backup, S3)
npm run new-site -- <nome> --name "Nome" --domain dominio.com.br   # novo blog
npm run api:password              # senha de aplicação + hash para o Wordbee
```

Sem `SITE`, vale `exemplo`.

## Criar um blog novo

### Pelo assistente: serviço + 3 variáveis (sem terminal)

1. No Easypanel, crie um serviço App com a imagem do repositório e um volume em `/data`.
2. Defina só estas variáveis (deixe `SITE` vazia ou de fora):
   - `SITE_URL`: `https://dominio.com.br`
   - `SETUP_TOKEN`: um código longo e aleatório, só seu
   - `ANTHROPIC_API_KEY`: a chave da API da Anthropic
3. Abra `https://dominio.com.br/admin/setup`, digite o código e informe nome, nicho, idioma e a senha do painel.
4. Revise o que a IA sugeriu (categorias, bio, página Sobre, frase e cores) e clique em **Publicar**.
5. Guarde a senha do Wordbee mostrada na tela: **ela aparece uma única vez**. Se perder, gere outra em `/admin`.
6. No Wordbee, cadastre o site como WordPress: endereço do blog, usuário `wordbee` e essa senha.

Até o passo 4, `/` mostra "Em configuração" (noindex) e os endpoints do Wordbee respondem 503. Terminado o
assistente, ele some; pode apagar `SETUP_TOKEN` e `ANTHROPIC_API_KEY`. Modelo de IA: `AI_MODEL`
(padrão `claude-sonnet-5-5`). As sugestões seguem o idioma escolhido; botões e páginas legais continuam em português.

### Por pasta no repositório

```bash
npm run new-site -- <nome> --name "Nome do Blog" --domain dominio.com.br \
  --categories "Receitas|receitas|Receitas fáceis;Dicas Rápidas|dicas-rapidas|Dicas do dia a dia"
# ou --categories-file categorias.json, com uma lista de { "name", "slug", "description" }
```

Isso cria `sites/<nome>/` com um `settings.json` inicial (categorias com ids a partir de 2, nome e cor). Publique
com `SITE=<nome>` e `SITE_URL`.

### Variáveis

| Variável | Quando | Para quê |
|---|---|---|
| `SITE_URL` | sempre | Domínio público |
| `SITE` | blog com pasta | Pasta em `sites/`. Vazia = assistente |
| `SETUP_TOKEN`, `ANTHROPIC_API_KEY`, `AI_MODEL` | só no assistente | Código de acesso, chave e modelo da IA |
| `ADMIN_USER`, `ADMIN_PASSWORD_HASH` | opcionais no assistente; necessárias para ter `/admin` num blog com pasta | Login do painel (`npm run admin:password`) |
| `WP_USER`, `WP_APP_PASSWORD_HASH` | opcionais | Senha do Wordbee (`npm run api:password`). Se existirem, têm prioridade sobre a gerada |

### O que o Wordbee enxerga

Um site WordPress comum, nos mesmos 4 endpoints de `/wp-json/wp/v2`: `users/me`, `categories`, `media` e `posts`.
- **Categorias:** as do `/admin`. Os ids nunca mudam nem são apagados; renomear não exige mudar nada no Wordbee.
- **Imagens:** o `source_url` é um JPEG otimizado, com `mime_type` `image/jpeg`; o arquivo enviado não é guardado.
- **Senha:** ao gerar outra em `/admin`, a anterior para de valer na hora; atualize o cadastro no Wordbee.

## Painel /admin

Login próprio, com bloqueio depois de 5 tentativas erradas. Cada "Salvar" valida, grava `/data/settings.json` de
forma atômica e pede um build (respeitando a trava global); o estado aparece no topo da tela. Campo vazio = vale o
`site.config.ts`.

- **Marca:** nome, logotipo e favicon (otimizados em `/data/assets`) e 3 cores, com prévia e aviso de contraste baixo. Principal: links, botões, foco, menu ativo, sumário e "Aceitar" dos cookies. Destaque: etiquetas, autor, títulos pequenos e "Leia também". Cartão: cartão da lateral, CTA e clube. Cabeçalho: fundo opcional, com texto calculado e logotipo opcional para fundo escuro.
- **Rastreamento:** ID do Tag Manager e códigos livres. Só carregam depois do aceite de estatísticas no banner.
- **Anúncios:** script da rede, `ads.txt` e 8 posições (topo, antes, dentro e depois do conteúdo, lateral no topo
  e no fim, rodapé e fixo no celular), cada uma com código, dispositivos, tipos de página, categorias e altura
  reservada. Só carregam depois do aceite de publicidade. Quem rejeita não vê os espaços.
- **Categorias:** renomear, mudar descrição e slug e adicionar. Slug antigo redireciona (301) e continua valendo
  para os posts já publicados.
- **Wordbee:** gerar nova senha.

Anúncio dentro do conteúdo: conta só `<p>` de primeiro nível e nunca fica colado num título, na seção de FAQ, no CTA,
no "Leia também" ou no fim do texto; nesses casos, vai para o próximo parágrafo possível. Códigos com `document.write`
não funcionam, porque o anúncio é inserido depois da página carregar.

## Como funciona a publicação

1. O Wordbee envia a imagem (`POST /wp-json/wp/v2/media`). Ela é otimizada (rotação aplicada, sem
   metadados, até 1600 px) e salva em `/wp-content/uploads/AAAA/MM/` como JPEG, que abre na hora e é o
   `source_url`, e como WebP para o blog, com variantes de 160, 480, 800 e 1200 px.
2. O Wordbee envia o post (`POST /wp-json/wp/v2/posts`). O HTML é sanitizado, convertido para
   Markdown e gravado. A resposta (`id`, `link`) sai em milissegundos; um POST repetido devolve
   o mesmo post.
3. Um build roda em segundo plano: fila com debounce, no máximo um por blog e N no VPS
   (trava global). Ele vai para uma pasta nova e o symlink `current` é trocado de uma vez.
   Se falhar, o site fica no release anterior.
4. O próprio servidor entrega o site (`current/`), as imagens e a API, com HTML sempre
   revalidado, assets com cache de 1 ano e arquivos pré-comprimidos (brotli/gzip).

O agendador interno faz um rebuild diário (atualiza cotação e último vídeo) e o backup
diário (com envio opcional para S3), num minuto diferente para cada blog.

## Teste local de ponta a ponta

```bash
WP_USER=wordbee WP_APP_PASSWORD_HASH=<hash> PORT=8080 npm start          # terminal 1
node scripts/simulate-wordbee.ts http://localhost:8080 wordbee "<senha>"  # terminal 2
```

Painel e assistente localmente:

```bash
npm run admin:password -- "minha senha"                                  # gera ADMIN_USER e ADMIN_PASSWORD_HASH
npm run admin:verify -- 'minha senha'                                   # diz se confere com o ADMIN_PASSWORD_HASH do ambiente
ADMIN_USER=admin ADMIN_PASSWORD_HASH=<hash> WP_USER=wordbee WP_APP_PASSWORD_HASH=<hash> PORT=8080 npm start
# abra http://localhost:8080/admin

SITE= SITE_URL=http://localhost:8080 SETUP_TOKEN=teste ANTHROPIC_API_KEY=<chave> TRUST_PROXY=0 PORT=8080 npm start
# abra http://localhost:8080/admin/setup (dados em .local/blog/)
```

## Formato de um post

```md
---
title: "Título"
description: "Meta description (opcional; se faltar, usa o excerpt)"
excerpt: "Resumo do card"
date: 2026-10-24T09:30:00-03:00
status: publish                       # publish | draft
category: roteiros                    # slug de uma categoria do site.config.ts
cover:
  src: /wp-content/uploads/2026/10/capa.png
  alt: "Descrição da imagem"
---

Texto em Markdown. ![alt](/wp-content/uploads/2026/10/foto.png "Legenda")

> [!DICA]
> Caixa de destaque. Também: [!ATENCAO] e [!INFO]. Um > comum também vira caixa.

## Perguntas frequentes
### Pergunta?
Resposta.   ← vira bloco de FAQ com FAQPage no JSON-LD
```

## Comentários (fora da v1)

Ponto de extensão: `src/components/article/ArticleView.astro`, depois de `<AuthorBox />`.
