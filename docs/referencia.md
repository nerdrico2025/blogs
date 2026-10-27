# Referência: viajandocomoleo.com

Baixado em 2026-10-26 com `curl` (home, `/page/2/`, `/category/destinos/`,
`/chicago-em-3-dias/`, `main.min.css` do tema e os `<style>` inline). Os arquivos
brutos ficaram fora do repositório de propósito: são conteúdo de terceiros.
Daqui só aproveitamos **layout, medidas e organização**. Nada de texto, imagem,
logo ou identidade.

Stack da referência: WordPress 7.1 + tema **Astra 4.14** (layout "separate
container", sidebar à esquerda, blog layout 5), Rank Math (metas e JSON-LD),
WPConsent (cookies), Site Kit (AdSense/Analytics) e um conjunto de componentes
próprios com prefixo `leo-` (ticker, sumário, caixa do autor, CTA etc.).

## Tokens de design (valores exatos do CSS)

### Cores
| Papel | Valor | Origem |
|---|---|---|
| Destaque / links | `#046bd2` | `--ast-global-color-0` |
| Destaque hover | `#045cb4` | `--ast-global-color-1` |
| Título / texto forte | `#1e293b` | `--ast-global-color-2` |
| Texto do corpo | `#334155` | `--ast-global-color-3` |
| Cartão | `#ffffff` | `--ast-global-color-4` |
| Fundo da página | `#f0f5fa` | `--ast-global-color-5` |
| Preto de botões e rótulos | `#111111` | `--ast-global-color-6/8` |
| Borda neutra | `#d1d5db` | `--ast-global-color-7` |
| Borda de cartão (componentes) | `#e8e8e8`, `#e7e7e7`, `#eeeeee` | `leo-*` |
| Fundo de caixa / placeholder | `#f8f8f8`, `#fafafa`, `#f3f3f3`, `#f6f6f6` | `leo-*` |
| Texto secundário | `#555555`, `#666666`, `#777777`, `#999999` | `leo-*` |
| YouTube | `#ff0000` | `.leo-youtube-button` |
| Verde da chamada | gradiente `#174c3c → #267858` (145°), rótulo `#c4e6d3`, texto `#e5f3ea` | `.leo-guias-card` |
| Verde do botão "clube" | `#115e59` | `.leo-author-club-button` |
| Ticker | fundo `#000`, texto `#fff`, separadores `rgba(255,255,255,.45/.65)` | `.leo-news-ticker` |
| Cookies | fundo `#04194e`, texto `#fff`, Aceitar `#ffcd2a`/preto, Rejeitar `#fff`/preto | `--wpconsent-*` |

### Tipografia
- **Não é Inter.** O corpo usa a pilha de sistema:
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif`.
- `html { font-size: 106.25% }` → **1rem = 17 px**. Corpo `17px`, `line-height: 1.65`, peso 400.
- Títulos do conteúdo, peso 600: H1 36 px (30 no mobile), H2 30 px (25), H3 24 px (20),
  H4 20 px, H5 18 px, H6 16 px. `line-height` 1,3 a 1,4.
- Títulos dos componentes, peso 700 a 800: autor 22 px, CTA 22 px, "Leia também"
  14 px, relacionados 24 px (seção) / 16 px (card), sumário 17 px.
- **Rótulos em caixa alta** ("kicker"): 9 a 11 px, peso 800,
  `letter-spacing` 0,7 a 1,1 px, cor `#777`/`#888`. Selo "MAIS RECENTE": 8 px,
  peso 800, fundo `#111`, raio 5 px, padding `4px 7px`.

### Raios
- Cartões grandes (autor, CTA, sumário, busca, YouTube, últimos artigos): **14 a 16 px**.
- Caixas menores e imagens: **10 a 11 px**. Botões: **8 a 9 px**. Miniaturas: 8 px.
- Pílulas (tempo de leitura): `999px`. Foto do autor: 50%.

### Sombras (sempre muito suaves)
- Cartão padrão: `0 5px 20px rgba(0,0,0,.045)` a `0 5px 22px rgba(0,0,0,.05)`.
- Sumário: `0 4px 18px rgba(0,0,0,.04)`. Cartão de destaque: `0 8px 25px rgba(0,0,0,.10)`.
- Botão hover: `0 6px 18px rgba(0,0,0,.12)`. Foto do autor: `0 3px 12px rgba(0,0,0,.10)`.

### Espaçamentos
- Padding de cartão de widget: 16 a 20 px (18 é o mais comum). Caixa do autor 26 px
  (20 no mobile). CTA 24 px (20). Artigo no desktop: `3em` ≈ 51 px.
- Gap entre widgets da sidebar: `2em` ≈ 34 px. Gaps internos de 7 a 22 px.

### Breakpoints
| Largura | Uso |
|---|---|
| `≤ 544px` | celular (ajustes finos de fonte e padding) |
| `≤ 768px` | ajustes dos componentes `leo-*` (cards relacionados em 1 coluna) |
| `≤ 921px` | **colapso do layout**: sidebar vai para baixo, menu vira hambúrguer |
| `≥ 922px` | layout em duas colunas |

### Container
- `.ast-container { max-width: 1240px }` (com padding lateral). Conteúdo 70%,
  sidebar 30%. Na prática, 1200 px úteis → sidebar ~340 px e conteúdo ~800 px.
  O pedido fala em ~1080 / 250 / 700. **Proposta:** container 1140 px, sidebar
  280 px, gap 32 px, conteúdo fluido (~828 px). Com 250 px os widgets ficam apertados
  (a lista "últimos artigos" usa miniatura de 78 px + texto). Ajustável na config.

## Estrutura

### Header
1. **Ticker** preto, 36 px de altura (34 no mobile), em loop horizontal:
   `DÓLAR R$ x,xx • EURO R$ x,xx • NOVA YORK hh:mm • SÃO PAULO hh:mm • TÓQUIO … ✈`
   (o conteúdo é duplicado para o loop ser contínuo; horários preenchidos por JS).
   Rótulo em `strong` 11 px peso 800, valor 12 px peso 500.
2. Barra branca: logo à esquerda, menu de categorias à direita, borda inferior
   sutil. Abaixo de 921 px vira hambúrguer com menu em gaveta.

### Home e categoria
- `<aside id="secondary">` vem **antes** de `<div id="primary">` no DOM e, no
  mobile, `flex-direction: column-reverse` coloca o conteúdo em cima. No nosso
  blog faremos o contrário (conteúdo primeiro no DOM, sidebar posicionada à esquerda
  via CSS Grid): melhor para leitor de tela e para o LCP.
- Lista: cartões horizontais (`blog-layout-5`), imagem `ast-width-md-6` à esquerda,
  à direita categoria, título H2, meta (autor/data) e resumo.
- Paginação: `1 2 … 11 Próximo →` em `/page/N/`, com `rel="next"` no `<head>`.
- Categoria: `/category/<slug>/`, mesma lista, com `BreadcrumbList`.

### Sidebar (ordem real na referência)
1. Busca (`leo-search-widget`): kicker + H3 19 px, campo de 44 px com fundo `#f8f8f8`,
   botão preto de 34 px com lupa dentro do campo.
2. Bloco HTML (newsletter).
3. YouTube (`leo-youtube-card`): miniatura com play vermelho de 46 px, título 16 px,
   botão vermelho.
4. Recursos (`leo-resources-sidebar`): ícone, H3, lista de itens, botão preto.
5. Chamada verde (`leo-guias-card`): ícone grande, kicker, H3 25 px branco, texto,
   botão branco de 48 px de altura.
6. Últimos artigos (`leo-editorial-widget`): destaque com selo "MAIS RECENTE"
   + 4 itens em grid `78px 1fr` (miniatura 78×58), título 12,5 px, data 9,5 px,
   link "ver todos".
7. Banner de imagem (afiliado).

### Artigo
- Barra de progresso de leitura (4 px, preto) no topo.
- H1, meta do autor, `leo-post-updated` (ícone de calendário + "Atualizado em"),
  `leo-reading-time` (pílula `#f6f6f6`, borda `#ececec`, 13 px peso 600).
- `leo-affiliate-disclosure`: caixa `#fafafa` com borda esquerda de 3 px `#777`, 12 px.
- `leo-toc` (sumário): cabeçalho com título e botão de recolher de 32 px
  (`#f3f3f3`, raio 8), itens H2 15 px `#333`, H3 recuados 18 px, 14 px `#666`.
- Imagens: `figure.wp-block-image` + `figcaption.wp-element-caption`.
- `leo-contextual-cta`: fundo `#f8f8f8`, borda `#e7e7e7`, raio 16, padding 24, kicker,
  título 22 px, texto 15 px `#555`, botão preto raio 9.
- `leo-read-more-box` ("Leia também"): fundo `#fafafa`, borda esquerda de 4 px `#111`,
  raio 10, kicker 10 px, link 14 px peso 700, seta `→` 20 px.
- `leo-related-posts`: borda superior, kicker + H2 24 px, grid de 3 colunas
  (2 até 768 px, 1 no celular), imagem com raio 10, categoria 10 px em caixa alta,
  título 16 px, "Ler artigo →" 12 px.
- `leo-author-box`: foto de 90 px (75 no mobile) com borda branca de 3 px e sombra,
  kicker, nome 22 px, bio 14 px `#555`, botões YouTube (vermelho) e Newsletter
  (preto) com ícone de 17 px, e bloco "clube" separado por borda superior com botão
  verde `#115e59`.
- `leo-share-bar`: barra flutuante branca, raio 14, botões de 42 px só com ícone
  (WhatsApp, Facebook, X, LinkedIn, Telegram, copiar), com toast "Link copiado"
  preto.
- Comentários: formulário nativo do WP (fora do escopo da v1).

### Rodapé e cookies
- Rodapé com links legais centralizados numa linha.
- Banner de cookies (WPConsent) fixo embaixo, fundo `#04194e`, três botões:
  Preferências, Rejeitar (branco), Aceitar (amarelo `#ffcd2a`), mais um modal de
  preferências por categoria e um botão flutuante para reabrir.

## SEO observado

- `robots`: `follow, index, max-snippet:-1, max-video-preview:-1, max-image-preview:large`.
- Canonical em todas as páginas; `rel="next"` na home paginada.
- Open Graph completo no artigo: `og:type=article`, `og:image` de **1600×900**
  com `width/height/type/alt/secure_url`, `article:published_time`,
  `article:modified_time`, `article:section`, `article:tag`, `og:updated_time`.
- Twitter: `summary_large_image`, `twitter:label1/data1` ("Escrito por"),
  `label2/data2` ("Tempo de leitura").
- JSON-LD em `@graph`:
  - home: `Person`, `WebSite`, `CollectionPage`;
  - categoria: `Person`, `WebSite`, `BreadcrumbList`, `CollectionPage`;
  - artigo: `Person`+`Organization`, `WebSite`, `ImageObject`, `BreadcrumbList`,
    `WebPage`, `Person` (autor), `BlogPosting` (`headline`, `keywords`,
    `datePublished`, `dateModified`, `articleSection`, `author`, `publisher`,
    `description`, `image`, `isPartOf`).
  - Não há `FAQPage` nem `SearchAction` no artigo analisado. Vamos incluir os dois.
- AdSense via meta `google-adsense-platform-account` (Site Kit).

## Imagens

- Todas em **webp**, proporção **16:9** (capa 1920×1080, OG 1600×900).
- Larguras geradas pelo WP: 150 (miniatura quadrada), 170, 300, 768, 1024, 1536, 1920.
- Card da home: `src` 768×432, `sizes="auto, (max-width: 768px) 100vw, 768px"`
  (desperdício: o card ocupa ~260 px).
- Imagens do corpo: `sizes="auto, (max-width: 1024px) 100vw, 1024px"`.
- No artigo analisado, a **primeira imagem do HTML** é a miniatura do YouTube na
  sidebar, com `loading="lazy"`; a capa não tem `fetchpriority`. Ponto de melhoria.

**Plano para o blog novo:** webp + avif em 150, 480, 768, 1024 e 1920 px,
`sizes` corretos por contexto (card ≈ `(max-width: 921px) 100vw, 280px`), `width`
e `height` sempre, fundo neutro `#eef2f6` como fallback, capa do artigo com
`fetchpriority="high"` e sem lazy, OG em 1200×630 gerado a partir da capa.
