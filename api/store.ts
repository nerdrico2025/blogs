/**
 * Estado da API: posts em src/content/posts/<slug>.md (o próprio conteúdo do blog)
 * e um arquivo JSON pequeno com contadores e o registro de mídias.
 * Todas as escritas passam por uma fila (uma de cada vez) e são atômicas (tmp + rename).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import site from "../site.config.ts";
import { RESERVED_SLUGS } from "../src/lib/slugs.ts";
import { processImage, safeBaseName, type MediaMeta } from "../shared/media.ts";
import type { ApiEnv } from "./env.ts";
import { badParam, WpError } from "./errors.ts";
import { htmlToMarkdown, plainText, truncate } from "./html-to-md.ts";

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
    if (existsSync(this.env.pagesDir)) {
      for (const f of await readdir(this.env.pagesDir)) if (f.endsWith(".md")) this.pageSlugs.add(f.replace(/\.md$/, ""));
    }
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
    for (const p of this.posts.values()) if (p.category === slug && p.status === "publish") n++;
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
      for (let i = 2; existsSync(path.join(this.env.uploadsDir, subdir, `${name}.json`)); i++) name = `${base}-${i}`;

      let meta: MediaMeta;
      try {
        meta = await processImage(data, { subdir, baseName: name, root: this.env.uploadsDir });
      } catch (err) {
        throw new WpError(415, "rest_upload_unknown_error", `Imagem inválida ou formato não suportado: ${(err as Error).message}`);
      }
      const id = this.state.nextMediaId++;
      const ext = meta.src.split(".").pop()!;
      const record: MediaRecord = {
        id,
        src: meta.src,
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
}
