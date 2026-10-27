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
shared/media.ts          processamento de imagens (webp/avif em 150–1920 px)
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

## Como funciona a publicação

1. O Wordbee envia a imagem (`POST /wp-json/wp/v2/media`). Ela é salva como chegou em
   `/wp-content/uploads/AAAA/MM/`, abre na hora e ganha variantes webp/avif.
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
