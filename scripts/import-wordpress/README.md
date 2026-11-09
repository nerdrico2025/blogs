# Importador de WordPress

Traz os posts publicados de um site WordPress para um blog deste repositório. Ele publica pelo
**mesmo caminho do Wordbee**: a API compatível com WordPress do blog (`POST /wp-json/wp/v2/media` e
`/posts`). Por isso o HTML passa pela mesma sanitização e conversão para Markdown, e as imagens pela
mesma otimização (JPEG + WebP em 160, 480, 800 e 1200 px, sem metadados).

```bash
IMPORT_BLOG_USER=wordbee IMPORT_BLOG_PASSWORD='<senha do Wordbee no blog>' \
npm run import-wordpress -- \
  --from https://site-antigo.com.br \
  --blog asasdomundo \
  --categories categorias.txt \
  --api https://endereco-do-blog-novo \
  --dry-run --limit 3
```

| Opção | Para quê |
|---|---|
| `--from <url>` | Site WordPress de origem. Lê `/wp-json/wp/v2/posts?_embed`, página por página, só os publicados |
| `--xml <arquivo>` | Exportação do WordPress (Ferramentas → Exportar → Posts). Usada se a REST API falhar, ou sozinha, sem `--from` |
| `--blog <nome>` | Blog de destino (`sites/<nome>/`) |
| `--categories <arquivo>` | Mapeamento de categorias de/para (modelo em `categorias.exemplo.txt`) |
| `--api <url>` | Endereço do blog novo. Padrão: o `url` do `site.config.ts` |
| `--user`, `--password` | Usuário e senha do Wordbee no blog (ou `IMPORT_BLOG_USER` e `IMPORT_BLOG_PASSWORD`) |
| `--redirects <arquivo>` | Onde gravar os 301. Padrão: `sites/<nome>/redirects.txt` |
| `--old-domain <host>` | Outro domínio do site antigo, para reescrever links (pode repetir) |
| `--dry-run` | Não grava nada: mostra, post a post, o que faria |
| `--limit <N>` | Só os N posts mais recentes |
| `--slug <a,b>` | Só estes posts |
| `--verbose` | Mostra o começo do HTML limpo de cada post (na simulação) |
| `--suggest-categories` | Só sugere o mapeamento de categorias (ver abaixo). Não importa nada |

**Antes de tudo:** o destino precisa ser o blog novo. Enquanto o domínio ainda aponta para o WordPress
antigo, o `url` do `site.config.ts` responde pelo WordPress. O script confere o `/health` do blog e, se não
for este projeto, para (na simulação, só avisa e usa as categorias do `site.config.ts`). Nesse período,
use `--api` com o endereço provisório do serviço no Easypanel.

## Sugerir o mapeamento de categorias

```bash
npm run import-wordpress -- --from https://site-antigo.com.br --blog <nome> --suggest-categories \
  [--categories sites/<nome>/categorias-wordpress.txt]
```

Lê as categorias da origem (`/wp-json/wp/v2/categories`, com contagem e pai) e os títulos dos posts, e as
categorias do `sites/<nome>/site.config.ts`. Para cada categoria antiga, escolhe a do blog mais parecida:
primeiro pelo nome e pelo slug (sem acento, sem plural, sem maiúsculas); se ficar abaixo do limiar, pelas
palavras dos títulos dos posts daquela categoria, comparadas com nome, slug e descrição de cada categoria do
blog. Subcategoria herda o destino da categoria pai, salvo nome mais parecido com outra.

- **Nunca cria categoria.** Sem correspondência razoável, o destino fica `?`, para você decidir.
- Grava no formato de `categorias.exemplo.txt`, uma regra por linha, com um comentário: confiança (alta,
  média ou baixa), de onde veio a sugestão e quantos posts a categoria tem. Subcategorias vêm antes.
- Arquivo: o de `--categories` ou, sem ele, `sites/<nome>/categorias-wordpress.txt`. **Se já existir, não é
  alterado:** a sugestão vai para `<arquivo>.sugerido`.
- Mostra a tabela origem → destino → confiança → posts e quantos posts cada categoria do blog receberia.
- Só lê a origem e grava o arquivo: não chama a API do destino.
- **Enquanto o arquivo tiver `?`, a importação e o `--dry-run` param** e listam as categorias a decidir.

## O que é feito com cada post

- **Preservado:** título, slug, data de publicação (`date_gmt`) e da última alteração, resumo, imagem
  destacada e meta title e meta description. O SEO vem do `yoast_head_json` (Yoast) ou, sem ele, do
  `<title>` e da `<meta name="description">` da página publicada (Rank Math e outros); no XML, dos campos
  `_yoast_wpseo_*` ou `rank_math_*`. O " - Nome do Site" do fim do título é removido, porque o blog já
  acrescenta o nome dele. O meta title vai para `seoTitle` no frontmatter, só se for diferente do título.
- **Categoria:** a primeira regra do arquivo de mapeamento que bater com alguma categoria do post.
- **Não importar:** no mapeamento, `categoria => -` marca uma categoria para ficar de fora (ex.: posts de
  demonstração do tema). O post que só tem categorias assim sai no relatório como "ignorado", sem contar como
  falha. Se ele também estiver numa categoria com regra, é importado por ela. O `-` vale antes do `*`, e a
  categoria ignorada não ganha redirect.
  Sem regra (e sem `*`), o post falha e aparece no relatório.
- **HTML:** saem comentários do Gutenberg, shortcodes (o texto dentro deles fica), classes, estilos,
  ids, `data-*`, `srcset` e `<span>`. Vídeo do YouTube vira um link "Vídeo: …"; outros iframes saem
  (aviso no relatório). Depois, o blog ainda aplica a allowlist dele.
- **Imagens:** todas, a destacada e as do corpo, são baixadas e enviadas pelo `POST /media`. Primeiro tenta
  o original (`foto.jpg` em vez de `foto-300x200.jpg` ou `foto-scaled.jpg`). GIF, AVIF e arquivos acima de
  15 MB são convertidos antes do envio. O alt original fica; se faltar ou for só o nome do arquivo
  (`P1010676`, `IMG_2034`), é gerado pela legenda, pelo `title` ou pelo título do post. Imagem que não
  baixa sai do texto e entra no relatório.
- **Links internos** para o domínio antigo (com ou sem `www`, `http` ou `https`) viram caminhos do blog
  novo: post → `/<slug>/`, categoria → `/category/<nova>/`. Link para a foto ampliada é desembrulhado.
  Link sem destino conhecido (uma página, por exemplo) fica com o mesmo caminho e é listado no relatório.

## Reimportar (idempotência)

Antes de enviar, o script procura o slug no blog (`GET /posts?slug=`). Se existe, atualiza no mesmo
endereço e com o mesmo id (`POST /posts/:id`); se nada mudou, o arquivo não é regravado e o post conta
como "sem mudanças". As imagens também não se repetem: o blog reconhece os mesmos bytes e devolve a
mídia já gravada. Pode rodar quantas vezes precisar, em partes (`--limit`, `--slug`).

## Mais de uma origem no mesmo blog

Cada post importado guarda de onde veio: `source: wordpress:<domínio de origem>` (o blog devolve esse campo
em `meta.source` no `GET /posts?slug=`). Na hora de atualizar, o importador confere a origem:

- **Mesma origem:** atualiza (ou "sem mudanças").
- **Importação antiga** (`source: wordpress`, sem domínio, como os posts do asasdomundo): atualiza e o post
  passa a ter o domínio desta origem. Da próxima vez, é "mesma origem".
- **Outra fonte** (outro domínio de WordPress, post publicado pelo Wordbee ou qualquer outra): **conflito**. O
  post do blog não é alterado, as imagens nem são baixadas, e o relatório diz de qual fonte é o post existente.
  No `--dry-run` aparece como "conflito". Para trazer o post, mude o slug na origem ou exclua o do blog.

O blog precisa estar na versão do servidor que devolve `meta.source`; se não estiver, o importador para e
pede o deploy.

## Redirecionamentos

O script grava, num bloco marcado do `redirects.txt` do blog, um 301 para cada endereço que mudou: post
com outro caminho (permalink com categoria, slug ocupado), categoria antiga → nova (inclusive as filhas,
`/category/lugares/america/`) e imagem antiga → nova. Caminhos iguais não geram regra. Regras fora do bloco
não são tocadas e têm prioridade. A cada rodada o bloco é completado, não apagado.

Dentro do bloco, cada origem tem a sua seção (`# origem: wordpress:<domínio>`), e uma rodada só mexe na seção da
própria origem. Se outra origem já tem regra para o mesmo caminho antigo (por exemplo, as duas tinham
`/category/noticias/`), a regra existente fica e o relatório mostra o conflito. Regras de antes das seções
(sem `# origem:`) continuam valendo; a origem que gera a mesma regra passa a ser dona dela, e uma regra com
outro destino vira conflito, sem troca.
O servidor lê o `redirects.txt` ao iniciar: depois de importar, faça commit e publique.
Links com data (`/2016/08/slug/`) já redirecionam sozinhos.

Os 301 só valem para pedidos que chegam ao blog novo. Se o domínio também mudou, aponte o domínio antigo
para outro redirecionamento (Cloudflare ou Traefik) para o novo.

## Relatório

No fim: importados, atualizados, sem mudanças, ignorados (categoria marcada com `-`), falhas (com o motivo), conflitos (slug de post de outra fonte
e caminhos de redirect de outra origem), imagens que não baixaram (post e URL), redirects gravados e avisos.
Código de saída 2 quando há falha ou conflito.

## Limites

- Só posts (não páginas), só publicados, uma categoria por post, sem tags (o blog não usa tags).
- O autor do WordPress é ignorado: quem assina é o autor do blog.
- A API do blog limita as requisições por minuto (`RATE_LIMIT_PER_MINUTE`, padrão 120). O script espera e
  continua quando bate no limite; numa importação grande, dá para subir o limite durante a migração.
- Na simulação, as imagens são só conferidas (HEAD), sem baixar nem otimizar.
