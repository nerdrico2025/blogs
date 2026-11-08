/**
 * Estado da API: posts em src/content/posts/<slug>.md (o próprio conteúdo do blog)
 * e um arquivo JSON pequeno com contadores e o registro de mídias.
 * Todas as escritas passam por uma fila (uma de cada vez) e são atômicas (tmp + rename).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import site from "../site.config.ts";
import { RESERVED_SLUGS } from "../src/lib/slugs.ts";
import { processImage, PUBLIC_PREFIX, safeBaseName, type MediaMeta } from "../shared/media.ts";
import { findCategory } from "../shared/settings.ts";
import type { ApiEnv } from "./env.ts";
import { badParam, WpError } from "./errors.ts";
import { htmlToMarkdown, plainText, truncate } from "./html-to-md.ts";
import { resolveImage, trashFolder, uploadRefs } from "./trash.ts";

export interface MediaRecord {
  id: number;
  src: string;
  mime: string;
  width: number;
  height: number;
  createdAt: string;
  /** Texto alternativo enviado em `alt_text` (opcional). */
  alt?: string;
  /** sha256 dos bytes e nome pedido: o mesmo arquivo, com o mesmo nome, enviado de novo devolve a mesma mídia. */
  hash?: string;
  name?: string;
}

interface State {
  nextPostId: number;
  nextMediaId: number;
  media: Record<string, MediaRecord>;
  /** Imagens de artigos excluídos (AAAA/MM/nome), cujo endereço não volta a ser usado. */
  retiredImages?: string[];
}

export interface ArticleSummary {
  slug: string;
  title: string;
  status: string;
  category: string;
  date: string;
  link: string;
}

export interface DeleteResult {
  deleted: string[];
  missing: string[];
  failed: { slug: string; error: string }[];
}

export interface PostRecord {
  id: number;
  slug: string;
  title: string;
  status: "publish" | "draft";
  category: string;
  date: string;
  hash: string;
  excerpt: string;
  featuredMedia: number;
}

export interface CreatePostInput {
  title: string;
  content: string;
  status: "publish" | "draft";
  excerpt?: string;
  slug?: string;
  categoryId?: number;
  featuredMedia?: number;
  /** Data de publicação (ISO). Sem ela, vale o momento do recebimento. */
  date?: string;
  /** Data da última alteração (ISO), usada só na atualização. */
  modified?: string;
  /** Título para buscadores (<title>), quando diferente do título do artigo. */
  seoTitle?: string;
  /** Meta description. Sem ela, sai do excerpt ou do começo do texto. */
  seoDescription?: string;
  /** Origem do post (frontmatter `source`). */
  source?: string;
}

/** Na atualização, só título e conteúdo são obrigatórios; o que faltar continua como está. */
export type UpdatePostInput = Partial<CreatePostInput> & { title: string; content: string };

async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90)
    .replace(/-+$/, "");
}

const contentHash = (title: string, content: string) =>
  createHash("sha256").update(JSON.stringify([title.trim(), content.trim()])).digest("hex");

export class Store {
  private state: State = { nextPostId: 1, nextMediaId: 1, media: {} };
  private posts = new Map<string, PostRecord>();
  private pageSlugs = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly env: ApiEnv;

  constructor(env: ApiEnv) {
    this.env = env;
  }

  async init(): Promise<void> {
    if (existsSync(this.env.stateFile)) {
      this.state = { ...this.state, ...JSON.parse(await readFile(this.env.stateFile, "utf8")) };
    }
    await mkdir(this.env.contentDir, { recursive: true });
    for (const file of await readdir(this.env.contentDir)) {
      if (!file.endsWith(".md")) continue;
      const raw = await readFile(path.join(this.env.contentDir, file), "utf8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      const data = YAML.parse(fm[1]!) as Record<string, unknown>;
      const slug = file.replace(/\.md$/, "");
      const id = Number(data.wpId);
      if (!Number.isInteger(id)) continue;
      this.posts.set(slug, {
        id,
        slug,
        title: String(data.title ?? ""),
        status: data.status === "draft" ? "draft" : "publish",
        category: String(data.category ?? ""),
        date: new Date(String(data.date)).toISOString(),
        hash: String(data.wpHash ?? ""),
        excerpt: String(data.excerpt ?? ""),
        featuredMedia: Number(data.wpFeaturedMedia ?? 0),
      });
      this.state.nextPostId = Math.max(this.state.nextPostId, id + 1);
    }
    await this.reloadPages();
  }

  async reloadPages(): Promise<void> {
    this.pageSlugs.clear();
    if (!existsSync(this.env.pagesDir)) return;
    for (const f of await readdir(this.env.pagesDir)) if (f.endsWith(".md")) this.pageSlugs.add(f.replace(/\.md$/, ""));
  }

  /** Executa operações de escrita uma de cada vez. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private saveState(): Promise<void> {
    return atomicWrite(this.env.stateFile, JSON.stringify(this.state, null, 2));
  }

  postLink(slug: string): string {
    return `${site.url}/${slug}/`;
  }

  countByCategory(slug: string): number {
    let n = 0;
    for (const p of this.posts.values()) if (findCategory(site.categories, p.category)?.slug === slug && p.status === "publish") n++;
    return n;
  }

  /** Artigos gravados com este slug de categoria, em qualquer status (inclusive rascunhos). */
  postsInCategory(slug: string): number {
    let n = 0;
    for (const p of this.posts.values()) if (p.category === slug) n++;
    return n;
  }

  /**
   * "Reiniciar para novo domínio": apaga todos os posts e imagens, na mesma fila da publicação.
   * O api-state.json fica: os números de post e de mídia nunca se repetem.
   */
  clearContent(): Promise<{ posts: number }> {
    return this.serial(async () => {
      let posts = 0;
      if (existsSync(this.env.contentDir)) {
        for (const f of await readdir(this.env.contentDir)) {
          if (!f.endsWith(".md")) continue;
          await rm(path.join(this.env.contentDir, f), { force: true });
          posts++;
        }
      }
      this.posts.clear();
      await rm(this.env.uploadsDir, { recursive: true, force: true });
      await mkdir(this.env.uploadsDir, { recursive: true });
      return { posts };
    });
  }

  get postCount(): number {
    return this.posts.size;
  }

  getMedia(id: number): MediaRecord | undefined {
    return this.state.media[String(id)];
  }

  private slugTaken(slug: string): boolean {
    return RESERVED_SLUGS.has(slug) || this.pageSlugs.has(slug);
  }

  /**
   * Grava a imagem otimizada. Os mesmos bytes com o mesmo nome de arquivo (retry, reimportação) devolvem
   * a mídia já gravada, com `created: false`; um alt novo substitui o anterior. Com outro nome, é outra mídia.
   */
  saveMedia(data: Buffer, filename: string, alt?: string): Promise<{ record: MediaRecord; meta: MediaMeta; created: boolean }> {
    return this.serial(async () => {
      const hash = createHash("sha256").update(data).digest("hex");
      const base = safeBaseName(filename);
      const same = Object.values(this.state.media).find((m) => m.hash === hash && m.name === base && existsSync(path.join(this.env.uploadsDir, m.src.slice(PUBLIC_PREFIX.length))));
      if (same) {
        const metaFile = path.join(this.env.uploadsDir, same.src.slice(PUBLIC_PREFIX.length).replace(/\.[a-z0-9]+$/, ".json"));
        const meta = JSON.parse(await readFile(metaFile, "utf8")) as MediaMeta;
        if (alt && alt !== same.alt) {
          same.alt = alt;
          await this.saveState();
        }
        return { record: same, meta, created: false };
      }
      const now = new Date();
      const subdir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      let name = base;
      const retired = new Set(this.state.retiredImages ?? []);
      for (let i = 2; existsSync(path.join(this.env.uploadsDir, subdir, `${name}.json`)) || retired.has(`${subdir}/${name}`); i++) name = `${base}-${i}`;

      let meta: MediaMeta;
      try {
        meta = await processImage(data, { subdir, baseName: name, root: this.env.uploadsDir, ...(alt ? { alt } : {}) });
      } catch (err) {
        throw new WpError(415, "rest_upload_unknown_error", `Imagem inválida ou formato não suportado: ${(err as Error).message}`);
      }
      const id = this.state.nextMediaId++;
      // O source_url é o JPEG; o HTML do blog acha o webp e as variantes pelo .json de mesmo nome
      const src = meta.jpeg ?? meta.src;
      const ext = src.split(".").pop()!;
      const record: MediaRecord = {
        id,
        src,
        mime: ext === "jpg" ? "image/jpeg" : `image/${ext}`,
        width: meta.width,
        height: meta.height,
        createdAt: now.toISOString(),
        ...(alt ? { alt } : {}),
        hash,
        name: base,
      };
      this.state.media[String(id)] = record;
      await this.saveState();
      return { record, meta, created: true };
    });
  }

  findBySlug(slug: string): PostRecord | undefined {
    return this.posts.get(slug);
  }

  findById(id: number): PostRecord | undefined {
    for (const p of this.posts.values()) if (p.id === id) return p;
    return undefined;
  }

  /** Posts com wpId, do mais recente para o mais antigo. */
  allPosts(): PostRecord[] {
    return [...this.posts.values()].sort((a, b) => b.date.localeCompare(a.date));
  }

  private category(categoryId: number | undefined) {
    const category = categoryId === undefined ? site.categories[0]! : site.categories.find((c) => c.id === categoryId);
    if (!category) throw badParam("categories", `Categoria ${categoryId} não existe.`);
    return category;
  }

  private media(featuredMedia: number | undefined): MediaRecord | undefined {
    const media = featuredMedia ? this.getMedia(featuredMedia) : undefined;
    if (featuredMedia && !media) throw new WpError(400, "rest_invalid_featured_media", `Mídia ${featuredMedia} não existe.`);
    return media;
  }

  /** Monta o arquivo .md (frontmatter + Markdown) de um post. */
  private async render(
    input: CreatePostInput,
    fixed: { id: number; title: string; hash: string; date: string; updated?: string; category: string; media?: MediaRecord }
  ): Promise<{ file: string; excerpt: string }> {
    const markdown = await htmlToMarkdown(input.content);
    const excerptText = input.excerpt ? plainText(input.excerpt) : "";
    const seoDescription = input.seoDescription ? plainText(input.seoDescription) : "";
    const description = truncate(seoDescription || excerptText || plainText(input.content), 155);
    const seoTitle = input.seoTitle ? plainText(input.seoTitle) : "";
    const { media } = fixed;
    const frontmatter: Record<string, unknown> = {
      title: fixed.title,
      ...(seoTitle && seoTitle !== fixed.title ? { seoTitle } : {}),
      description,
      ...(excerptText ? { excerpt: truncate(excerptText, 300) } : {}),
      date: fixed.date,
      ...(fixed.updated && fixed.updated > fixed.date ? { updated: fixed.updated } : {}),
      status: input.status,
      category: fixed.category,
      ...(media ? { cover: { src: media.src, alt: media.alt || fixed.title } } : {}),
      wpId: fixed.id,
      wpHash: fixed.hash,
      ...(media ? { wpFeaturedMedia: media.id } : {}),
      source: input.source || "wordbee",
    };
    return { file: `---\n${YAML.stringify(frontmatter, { lineWidth: 0 })}---\n\n${markdown}`, excerpt: excerptText };
  }

  /**
   * Cria o post. Idempotente: mesmo slug e mesmo conteúdo devolvem o post existente
   * (`created: false`); mesmo slug com conteúdo diferente vira slug-2, slug-3…
   */
  createPost(input: CreatePostInput): Promise<{ post: PostRecord; created: boolean }> {
    return this.serial(async () => {
      const title = plainText(input.title);
      if (!title) throw badParam("title", "O título não pode ficar vazio.");
      if (!input.content.trim()) throw badParam("content", "O conteúdo não pode ficar vazio.");
      const category = this.category(input.categoryId);
      const media = this.media(input.featuredMedia);

      const hash = contentHash(title, input.content);
      const base = slugify(input.slug || title) || `post-${this.state.nextPostId}`;
      let slug = base;
      for (let i = 2; ; i++) {
        const existing = this.posts.get(slug);
        if (existing && existing.hash === hash) return { post: existing, created: false };
        if (!existing && !this.slugTaken(slug)) break;
        slug = `${base}-${i}`;
      }

      const date = input.date ?? new Date().toISOString();
      const id = this.state.nextPostId++;
      const { file, excerpt } = await this.render(input, { id, title, hash, date, updated: input.modified, category: category.slug, media });
      await atomicWrite(path.join(this.env.contentDir, `${slug}.md`), file);
      await this.saveState();

      const post: PostRecord = { id, slug, title, status: input.status, category: category.slug, date, hash, excerpt, featuredMedia: media?.id ?? 0 };
      this.posts.set(slug, post);
      return { post, created: true };
    });
  }

  /**
   * Atualiza um post existente (POST /posts/:id). O slug e o id não mudam. Campos ausentes
   * continuam como estão; título e conteúdo são sempre reenviados, porque o post guarda Markdown.
   * `changed: false` quando o arquivo resultante é idêntico ao atual (nada é gravado).
   */
  updatePost(id: number, input: UpdatePostInput): Promise<{ post: PostRecord; changed: boolean }> {
    return this.serial(async () => {
      const current = this.findById(id);
      if (!current) throw new WpError(404, "rest_post_invalid_id", "ID de post inválido.");
      const title = plainText(input.title);
      if (!title) throw badParam("title", "O título não pode ficar vazio.");
      if (!input.content.trim()) throw badParam("content", "O conteúdo não pode ficar vazio.");

      const mdFile = path.join(this.env.contentDir, `${current.slug}.md`);
      const raw = await readFile(mdFile, "utf8");
      const old = (YAML.parse(raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "") ?? {}) as Record<string, unknown>;

      const category = input.categoryId === undefined ? findCategory(site.categories, current.category) ?? this.category(undefined) : this.category(input.categoryId);
      const featured = input.featuredMedia === undefined ? current.featuredMedia || undefined : input.featuredMedia || undefined;
      const media = this.media(featured);
      const merged: CreatePostInput = {
        title: input.title,
        content: input.content,
        status: input.status ?? current.status,
        excerpt: input.excerpt ?? (current.excerpt || undefined),
        seoTitle: input.seoTitle ?? (typeof old.seoTitle === "string" ? old.seoTitle : undefined),
        // Sem meta description nova, ela volta a sair do excerpt ou do texto
        seoDescription: input.seoDescription,
        source: input.source ?? (typeof old.source === "string" ? old.source : undefined),
      };
      const hash = contentHash(title, input.content);
      const date = input.date ?? current.date;
      const oldUpdated = old.updated ? new Date(String(old.updated)).toISOString() : undefined;
      const bodyChanged = hash !== current.hash;
      const updated = input.modified ?? (bodyChanged ? new Date().toISOString() : oldUpdated);

      const { file, excerpt } = await this.render(merged, { id, title, hash, date, updated, category: category.slug, media });
      const post: PostRecord = { ...current, title, status: merged.status, category: category.slug, date, hash, excerpt, featuredMedia: media?.id ?? 0 };
      if (file === raw) return { post: current, changed: false };
      await atomicWrite(mdFile, file);
      this.posts.set(current.slug, post);
      return { post, changed: true };
    });
  }

  /** Todos os artigos em disco, inclusive os sem wpId. Lê os arquivos a cada chamada. */
  async listArticles(): Promise<ArticleSummary[]> {
    const out: ArticleSummary[] = [];
    for (const file of await readdir(this.env.contentDir)) {
      if (!file.endsWith(".md")) continue;
      const slug = file.replace(/\.md$/, "");
      let data: Record<string, unknown> = {};
      try {
        const fm = (await readFile(path.join(this.env.contentDir, file), "utf8")).match(/^---\n([\s\S]*?)\n---/);
        if (fm) data = (YAML.parse(fm[1]!) as Record<string, unknown>) ?? {};
      } catch {
        // Arquivo com cabeçalho quebrado continua na lista, para poder ser apagado
      }
      const category = String(data.category ?? "");
      const date = new Date(String(data.date));
      out.push({
        slug,
        title: String(data.title ?? slug),
        status: String(data.status ?? "publish"),
        category: findCategory(site.categories, category)?.name ?? category,
        date: Number.isNaN(date.getTime()) ? "" : date.toISOString(),
        link: this.postLink(slug),
      });
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  /** Referências a imagens em tudo que continua publicado ou pode voltar a ser: posts, páginas e configurações. */
  private async imageUsers(): Promise<Map<string, string[]>> {
    const users = new Map<string, string[]>();
    const read = async (id: string, file: string) => users.set(id, uploadRefs(await readFile(file, "utf8")));
    for (const f of await readdir(this.env.contentDir)) if (f.endsWith(".md")) await read(`post:${f.replace(/\.md$/, "")}`, path.join(this.env.contentDir, f));
    if (existsSync(this.env.pagesDir)) for (const f of await readdir(this.env.pagesDir)) if (f.endsWith(".md")) await read(`page:${f}`, path.join(this.env.pagesDir, f));
    if (existsSync(this.env.settingsFile)) await read("settings", this.env.settingsFile);
    return users;
  }

  /**
   * Exclui artigos, um por vez, na mesma fila da publicação. Ordem: copia para a lixeira; só então apaga
   * o .md, que é o que tira o artigo do site; depois, as imagens que mais ninguém usa. Se a cópia falhar,
   * nada é apagado. O número do post nunca é reaproveitado, e o slug fica livre para um post novo.
   */
  deletePosts(slugs: string[]): Promise<DeleteResult> {
    return this.serial(async () => {
      const result: DeleteResult = { deleted: [], missing: [], failed: [] };
      const users = await this.imageUsers();
      for (const slug of new Set(slugs)) {
        // O slug só serve para achar um arquivo da lista: nunca entra num caminho sem existir nela
        if (!users.has(`post:${slug}`)) {
          result.missing.push(slug);
          continue;
        }
        try {
          await this.deleteOne(slug, users);
          users.delete(`post:${slug}`);
          result.deleted.push(slug);
        } catch (err) {
          result.failed.push({ slug, error: (err as Error).message });
        }
      }
      return result;
    });
  }

  private async deleteOne(slug: string, users: Map<string, string[]>): Promise<void> {
    const mdFile = path.join(this.env.contentDir, `${slug}.md`);
    const uploads = this.env.uploadsDir;
    const own = users.get(`post:${slug}`)!.flatMap((rel) => resolveImage(uploads, rel) ?? []);
    const others = [...users].filter(([id]) => id !== `post:${slug}`).flatMap(([, refs]) => refs).flatMap((rel) => resolveImage(uploads, rel) ?? []);
    const usedKeys = new Set(others.map((i) => i.key));
    const usedFiles = new Set(others.flatMap((i) => i.files));
    const images = [...new Map(own.map((i) => [i.key, i])).values()].filter((i) => !usedKeys.has(i.key));
    const files = [...new Set(images.flatMap((i) => i.files))].filter((f) => !usedFiles.has(f) && existsSync(path.join(uploads, f)));

    const removed = new Set(files.map((f) => `${PUBLIC_PREFIX}${f}`));
    const media = Object.values(this.state.media).filter((m) => removed.has(m.src));

    const folder = await trashFolder(this.env.trashDir, slug);
    const partial = `${folder}.partial`;
    await rm(partial, { recursive: true, force: true });
    try {
      await cp(mdFile, path.join(partial, `${slug}.md`));
      for (const f of files) await cp(path.join(uploads, f), path.join(partial, "uploads", f));
      await writeFile(path.join(partial, "manifest.json"), JSON.stringify({ slug, deletedAt: new Date().toISOString(), post: this.posts.get(slug) ?? null, media, files }, null, 2));
      await rename(partial, folder);
    } catch (err) {
      await rm(partial, { recursive: true, force: true });
      throw err;
    }

    await rm(mdFile);
    this.posts.delete(slug);
    for (const m of media) delete this.state.media[String(m.id)];
    // Imagem com endereço de cache longo: um upload futuro com o mesmo nome ganha outro endereço
    this.state.retiredImages = [...new Set([...(this.state.retiredImages ?? []), ...images.map((i) => i.key)])];
    await this.saveState();
    // Lixo que sobrar aqui é só espaço em disco: o artigo já saiu e a cópia está guardada
    await Promise.allSettled(files.map((f) => rm(path.join(uploads, f), { force: true })));
  }
}
