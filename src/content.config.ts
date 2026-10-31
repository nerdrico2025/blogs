import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import path from "node:path";
import { localDataDir, siteDir } from "./lib/site-id.ts";

const posts = defineCollection({
  // Os posts ficam fora do código (CONTENT_DIR; no container, /data/content/posts)
  loader: glob({ pattern: "**/*.md", base: process.env.CONTENT_DIR ?? path.join(localDataDir(), "content", "posts") }),
  schema: z.object({
    title: z.string().min(1),
    /** Meta description. Se faltar, usa o excerpt. */
    description: z.string().optional(),
    excerpt: z.string().optional(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    status: z.enum(["publish", "draft", "future", "trash"]).default("publish"),
    category: z.string(),
    tags: z.array(z.string()).default([]),
    author: z.string().optional(),
    cover: z
      .object({
        src: z.string(),
        alt: z.string(),
        caption: z.string().optional(),
      })
      .optional(),
    /** Id numérico exposto pela API compatível com WordPress. */
    wpId: z.number().int().optional(),
    /** Hash de título + conteúdo, para reconhecer um POST repetido. */
    wpHash: z.string().optional(),
    wpFeaturedMedia: z.number().int().optional(),
    /** Origem do post (ex.: "wordbee"). */
    source: z.string().optional(),
  }),
});

const pages = defineCollection({
  // Páginas fixas: sites/<SITE>/pages; nos blogs do assistente, PAGES_DIR no volume
  loader: glob({ pattern: "**/*.md", base: process.env.PAGES_DIR ?? path.join(siteDir(), "pages") }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    updated: z.coerce.date().optional(),
    schemaType: z.enum(["WebPage", "AboutPage", "ContactPage"]).default("WebPage"),
  }),
});

export const collections = { posts, pages };
