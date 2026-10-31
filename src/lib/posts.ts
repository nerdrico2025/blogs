import { getCollection, type CollectionEntry } from "astro:content";
import site from "../../site.config.ts";
import type { Author, Category } from "./config-schema.ts";
import type { FaqItem } from "../markdown/rehype-blog.ts";
import { findCategory } from "../../shared/settings.ts";

export type Post = CollectionEntry<"posts">;

export interface PostView {
  entry: Post;
  slug: string;
  url: string;
  title: string;
  description: string;
  excerpt: string;
  date: Date;
  updated: Date;
  category: Category;
  author: Author & { id: string };
  readingTime: number;
  words: number;
  faq: FaqItem[];
}

const BUILD_TIME = new Date();

/** Publicado e com data já alcançada (posts `future` entram quando a data chega). */
export function isVisible(p: Post, now = BUILD_TIME): boolean {
  if (p.data.status === "draft" || p.data.status === "trash") return false;
  return p.data.date.getTime() <= now.getTime();
}

export function categoryBySlug(slug: string): Category | undefined {
  return findCategory(site.categories, slug);
}

export function postUrl(slug: string): string {
  return `/${slug}/`;
}

function plain(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,.;:!?-]+$/, "") + "…";
}

function firstParagraph(html: string): string {
  const m = html.match(/<p>([\s\S]*?)<\/p>/);
  return m ? m[1]!.replace(/<[^>]+>/g, "") : "";
}

export function toView(entry: Post): PostView {
  const meta = (entry.rendered?.metadata?.frontmatter ?? {}) as { readingTime?: number; words?: number; faq?: FaqItem[] };
  const category = categoryBySlug(entry.data.category);
  if (!category) throw new Error(`Post "${entry.id}" usa categoria inexistente: ${entry.data.category}`);
  const authorId = entry.data.author && site.authors[entry.data.author] ? entry.data.author : site.defaultAuthor;
  const excerpt = plain(entry.data.excerpt ?? firstParagraph(entry.rendered?.html ?? ""), 220);
  return {
    entry,
    slug: entry.id,
    url: postUrl(entry.id),
    title: entry.data.title,
    description: plain(entry.data.description ?? excerpt, 158),
    excerpt,
    date: entry.data.date,
    updated: entry.data.updated ?? entry.data.date,
    category,
    author: { ...site.authors[authorId]!, id: authorId },
    readingTime: meta.readingTime ?? 1,
    words: meta.words ?? 0,
    faq: meta.faq ?? [],
  };
}

let cached: PostView[] | null = null;

/** Posts visíveis, do mais recente para o mais antigo. */
export async function getPosts(): Promise<PostView[]> {
  if (cached) return cached;
  const all = await getCollection("posts", (p) => isVisible(p));
  cached = all.map(toView).sort((a, b) => b.date.getTime() - a.date.getTime());
  return cached;
}

export async function getPostsByCategory(slug: string): Promise<PostView[]> {
  return (await getPosts()).filter((p) => p.category.slug === slug);
}

/** Relacionados: mesma categoria primeiro, depois tags em comum, depois os mais recentes. */
export function related(post: PostView, all: PostView[], count: number): PostView[] {
  const tags = new Set(post.entry.data.tags);
  return all
    .filter((p) => p.slug !== post.slug)
    .map((p) => ({
      p,
      score: (p.category.slug === post.category.slug ? 10 : 0) + p.entry.data.tags.filter((t) => tags.has(t)).length,
    }))
    .sort((a, b) => b.score - a.score || b.p.date.getTime() - a.p.date.getTime())
    .slice(0, count)
    .map((x) => x.p);
}

export function paginate<T>(items: T[], perPage: number) {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  return Array.from({ length: pages }, (_, i) => ({
    page: i + 1,
    pages,
    items: items.slice(i * perPage, (i + 1) * perPage),
  }));
}
