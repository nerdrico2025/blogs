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
}

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

  get postCount(): number {
    return this.posts.size;
  }

  getMedia(id: number): MediaRecord | undefined {
    return this.state.media[String(id)];
  }

  private slugTaken(slug: string): boolean {
    return RESERVED_SLUGS.has(slug) || this.pageSlugs.has(slug);
  }

  saveMedia(data: Buffer, filename: string): Promise<{ record: MediaRecord; meta: MediaMeta }> {
    return this.serial(async () => {
      const now = new Date();
      const subdir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const base = safeBaseName(filename);
      let name = base;
      const retired = new Set(this.state.retiredImages ?? []);
      for (let i = 2; existsSync(path.join(this.env.uploadsDir, subdir, `${name}.json`)) || retired.has(`${subdir}/${name}`); i++) name = `${base}-${i}`;

      let meta: MediaMeta;
      try {
        meta = await processImage(data, { subdir, baseName: name, root: this.env.uploadsDir });
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
      };
      this.state.media[String(id)] = record;
      await this.saveState();
      return { record, meta };
    });
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

      const category = input.categoryId === undefined
        ? site.categories[0]!
        : site.categories.find((c) => c.id === input.categoryId);
      if (!category) throw badParam("categories", `Categoria ${input.categoryId} não existe.`);

      const media = input.featuredMedia ? this.getMedia(input.featuredMedia) : undefined;
      if (input.featuredMedia && !media) {
        throw new WpError(400, "rest_invalid_featured_media", `Mídia ${input.featuredMedia} não existe.`);
      }

      const hash = contentHash(title, input.content);
      const base = slugify(input.slug || title) || `post-${this.state.nextPostId}`;
      let slug = base;
      for (let i = 2; ; i++) {
        const existing = this.posts.get(slug);
        if (existing && existing.hash === hash) return { post: existing, created: false };
        if (!existing && !this.slugTaken(slug)) break;
        slug = `${base}-${i}`;
      }

      const markdown = await htmlToMarkdown(input.content);
      const excerptText = input.excerpt ? plainText(input.excerpt) : "";
      const bodyText = plainText(input.content);
      const description = truncate(excerptText || bodyText, 155);
      const date = new Date().toISOString();
      const id = this.state.nextPostId++;

      const frontmatter: Record<string, unknown> = {
        title,
        description,
        ...(excerptText ? { excerpt: truncate(excerptText, 300) } : {}),
        date,
        status: input.status,
        category: category.slug,
        ...(media ? { cover: { src: media.src, alt: title } } : {}),
        wpId: id,
        wpHash: hash,
        ...(media ? { wpFeaturedMedia: media.id } : {}),
        source: "wordbee",
      };
      const file = `---\n${YAML.stringify(frontmatter, { lineWidth: 0 })}---\n\n${markdown}`;
      await atomicWrite(path.join(this.env.contentDir, `${slug}.md`), file);
      await this.saveState();

      const post: PostRecord = {
        id,
        slug,
        title,
        status: input.status,
        category: category.slug,
        date,
        hash,
        excerpt: excerptText,
        featuredMedia: media?.id ?? 0,
      };
      this.posts.set(slug, post);
      return { post, created: true };
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
