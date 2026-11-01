# Integração Wordbee → WordPress (como funciona hoje)

Fonte: `nerdrico2025/wordbee-clone` (clone raso, lido em 2026-10-26).
Código relevante: `packages/shared/src/wordpress/client.ts` (único cliente HTTP),
chamado por `apps/web/src/lib/article-pipeline.ts` (artigo manual e reenvio),
`apps/worker/src/line-pipeline.ts` (linhas de produção automáticas) e
`apps/worker/src/distribution-package-builder.ts` (álbum de imagens para Facebook).

## Resumo

O Wordbee usa **só 4 chamadas** da WordPress REST API. Todas cabem num
subconjunto pequeno, então o blog novo pode ser conectado **sem nenhuma mudança
no Wordbee**: basta cadastrar o site com a URL do blog novo, um usuário e uma
"senha de aplicação" emitida pela nossa API.

| # | Função no Wordbee | Requisição | Usado para |
|---|---|---|---|
| 1 | `testConnection` | `GET /wp-json/wp/v2/users/me?context=edit` | botão "Testar conexão" |
| 2 | `listCategories` | `GET /wp-json/wp/v2/categories?per_page=100&orderby=name&order=asc` | combo de categorias no cadastro de artigo/linha |
| 3 | `uploadMedia` | `POST /wp-json/wp/v2/media` (binário cru) | imagem de capa e imagens extras de álbum |
| 4 | `createPost` | `POST /wp-json/wp/v2/posts` (JSON) | publicar o artigo |

Não usa: atualização de post (`POST /posts/:id`), exclusão, `GET /posts`,
tags, `status=future`, `date`, campos de SEO (Yoast/RankMath), `alt_text`,
`POST /categories`, imagens dentro do corpo.

## Montagem da URL

```ts
const base = await assertSafeWordPressUrl(creds.url);           // URL cadastrada no Wordbee
const restBase = `${base.origin}${base.pathname.replace(/\/$/, "")}/wp-json/wp/v2`;
```

- Aceita `http://` e `https://`, bloqueia localhost/IP privado (anti-SSRF, também
  via DNS). **Consequência:** para testes de ponta a ponta o blog precisa estar num
  domínio público; `localhost` é recusado pelo Wordbee.
- Respeita subpasta (`https://site.com/blog` → `/blog/wp-json/wp/v2`), mas vamos
  usar a raiz do domínio. O Nginx encaminha `/wp-json/` para a API Fastify.

## Autenticação

```
Authorization: Basic base64("<usuario>:<appPassword>")
User-Agent: WordbeeClone/1.0 (+uso-pessoal)
```

A senha de aplicação é guardada cifrada (AES-GCM) no banco do Wordbee. A nossa API
compara `usuario` e `appPassword` com valores do `.env` em tempo constante. O
WordPress aceita a senha de aplicação com ou sem espaços (`abcd efgh ...`); vamos
normalizar removendo espaços, como o WP faz.

## Tratamento de erros e retentativas (importa para o nosso lado)

- Timeout: **15 s** em todas as chamadas, **30 s** no upload de mídia.
- Retenta até 3× (500 ms, 1 s) **só** em erro de rede ou timeout. Se a nossa API
  demorar para responder um `POST /posts`, o Wordbee reenvia o mesmo post. Por isso
  a criação precisa ser **idempotente por slug**: mesmo slug recebido em sequência
  devolve o post já criado em vez de criar `slug-2`.
- Status HTTP: 401 → "usuário ou senha inválidos", 403 → "acesso negado/WAF",
  404 → "REST API não encontrada", qualquer outro → erro genérico. O corpo do erro
  é truncado em 200 caracteres e mostrado ao usuário; usar o formato de erro do WP
  (`{"code":"rest_...","message":"...","data":{"status":401}}`).
- Logo, **o build não pode acontecer dentro da requisição**: respondemos em
  milissegundos e o build roda numa fila separada.

## 1. `GET /users/me?context=edit`

Lê apenas `id` e `roles`. **Exige `roles` contendo `"administrator"`**, senão o
Wordbee mostra "O usuário informado não tem permissão de administrador".

Resposta mínima:
```json
{ "id": 1, "name": "Autor", "slug": "autor", "roles": ["administrator"] }
```

## 2. `GET /categories?per_page=100&orderby=name&order=asc`

Lê `id` e `name` de cada item. O usuário escolhe uma categoria e o Wordbee guarda o
**id numérico** (`categoriaWpId`, mais `categoriaWpNome` nas linhas de produção).

Implicação: as categorias do `site.config.ts` precisam de um **id numérico
estável** (nunca reaproveitado), porque o Wordbee guarda esse número.

Resposta (formato WP; campos extras são ignorados pelo Wordbee):
```json
[{ "id": 3, "name": "Destinos", "slug": "destinos", "description": "...", "count": 12, "link": "https://dominio/category/destinos/", "parent": 0 }]
```

## 3. `POST /media`

```
Content-Type: image/png | image/jpeg        (vem do provedor de IA de imagem)
Content-Disposition: attachment; filename="<slug>.png"
<corpo = bytes da imagem>
```
- Nome do arquivo: `<slug>.png|jpg`, ou `<slug>-divulgacao-N.png` no álbum.
- Lê `id` e `source_url` da resposta.
- **Não envia `alt_text`, `title` nem `caption`.** O alt da capa terá de ser
  derivado do título do post.
- **`source_url` precisa ficar publicamente acessível na hora**, porque o módulo de
  distribuição usa essa URL para publicar no Facebook (a Meta busca a foto pela URL)
  e para a pessoa baixar a imagem. Então um JPEG otimizado fica num diretório servido
  direto (`/wp-content/uploads/AAAA/MM/arquivo.jpg`), sem depender de build. Não é WebP porque
  a Meta não o aceita de forma confiável. O arquivo enviado não é guardado.
- Imagens de álbum são enviadas como mídia mas **não** são associadas a nenhum post;
  ficam só como hospedagem pública.

Resposta mínima:
```json
{ "id": 42, "source_url": "https://dominio/wp-content/uploads/2026/10/slug.jpg", "media_type": "image", "mime_type": "image/jpeg" }
```

## 4. `POST /posts`

Corpo enviado (campos opcionais só vão quando existem):
```json
{
  "title": "Título (metaTitle da IA, se ≤ 60 caracteres)",
  "content": "<h2>...</h2><p>...</p>",
  "status": "publish" | "draft",
  "excerpt": "resumo gerado pela IA",
  "slug": "slug-gerado-pela-ia",
  "categories": [3],
  "featured_media": 42
}
```
- Lê `id` e `link` da resposta. `link` é gravado como `wpUrl` e usado depois pela
  distribuição (Facebook). Precisa ser a URL final do artigo
  (`https://dominio/<slug>/`), mesmo que o build ainda esteja rodando.
- `status` é só `publish` ou `draft`. Não há `future` nem `date`: a data de
  publicação é o momento do recebimento.
- Uma categoria só, nunca tags.
- O `excerpt` é o único texto curto disponível; vai virar **meta description** e
  resumo do card (truncado em ~155 caracteres para a meta).

### Formato do HTML (`content`)

Definido no prompt (`packages/shared/src/prompts/common.ts`): só
`<h2> <h3> <p> <ul> <ol> <li> <strong> <em> <blockquote>`, sem `<h1>`, sem markdown,
sem imagens, sem links, sem tabelas. O conversor HTML→Markdown deve aceitar mais que
isso (tabelas, `<img>`, `<a>`, `<figure>`) para o caso de o prompt mudar ou de
outras fontes, mas o caso real hoje é simples.

FAQ: não há marcação estruturada. Para gerar `FAQPage` vamos detectar um `<h2>`
com "Perguntas frequentes"/"FAQ" seguido de pares `<h3>` (pergunta) + `<p>`
(resposta).

## Contrato final da v1 (confirmado em 27/10)

O blog **imita a WordPress REST API** e o Wordbee o cadastra como "site WordPress",
**sem nenhuma mudança no app** (referência: commit `f5aaf41` do `wordbee-clone`).

| Método | Caminho (sob `/wp-json/wp/v2`) | Resposta |
|---|---|---|
| GET | `/users/me?context=edit` | `200 {"id", "name", "slug", "roles": ["administrator"]}` |
| GET | `/categories?per_page=100&orderby=name&order=asc` | `200 [{"id", "name", "slug", ...}]`, das categorias do `site.config.ts` |
| POST | `/media` (binário puro, `image/jpeg`, `image/png` ou `image/webp`) | `201 {"id", "source_url", ...}` com `source_url` em `/wp-content/uploads/AAAA/MM/<arquivo>`, que abre na hora |
| POST | `/posts` (JSON) | `201 {"id", "link", "slug", "status"}` com `link` na URL pública final |

Fora da v1: `POST /api/publish` próprio, tags, atualização de post, `status=future`,
`date`, campos de SEO e `alt_text`. Os valores que o Wordbee não envia são preenchidos
pelo blog: o `alt` da capa sai do título, a meta description do `excerpt` (ou dos
primeiros ~155 caracteres do texto), a data é o momento do recebimento e o tempo de
leitura é calculado no build.

Regras:
- **Autenticação:** Basic Auth com usuário e senha de aplicação vindos de variáveis de
  ambiente. Guardamos só o hash da senha e comparamos em tempo constante. Respostas:
  401 para credencial errada, 403 para permissão negada e 404 para rota inexistente,
  no formato de erro do WP.
- **Ids:** sempre inteiros; os das categorias são estáveis.
- **Resposta rápida:** o build roda em segundo plano, numa fila com debounce, e é publicado
  de forma atômica (build em pasta nova + troca de symlink). A resposta 201 sai antes
  do fim do build.
- **Idempotência:** mesmo slug **e mesmo conteúdo** (título + HTML) devolve o post existente
  (mesmo `id` e `link`, com **200** em vez de 201; o Wordbee só confere `res.ok`); mesmo
  slug com conteúdo diferente cria `slug-2`. Funciona também depois de reiniciar a API,
  porque o hash fica no frontmatter (`wpHash`).
- **Depois de excluir no /admin:** o slug fica livre. O mesmo slug, mesmo com o mesmo conteúdo, cria um post novo (201) com outro id; o excluído não volta. O `id` da imagem excluída deixa de existir (`featured_media` com ele dá 400), então a imagem precisa ser enviada de novo.
- **Sanitização:** o HTML recebido não vem sanitizado. Usamos uma allowlist com as tags
  do prompt do Wordbee mais `a`, `table`, `thead`, `tbody`, `tr`, `th`, `td` e `img`
  (com atributos seguros). Nada de `<script>` nem atributos `on*`.
- **Rascunho:** `status=draft` grava o post com `status: draft`, fora do build público.
- **Enriquecimento no build** (já implementado nas Fases 2 e 3): sumário, CTA no meio do
  texto, "Leia também" da mesma categoria, relacionados por categoria, `<blockquote>`
  como caixa de destaque e FAQ (`<h3>` + `<p>` depois de um H2 "Perguntas frequentes")
  com `FAQPage`.
