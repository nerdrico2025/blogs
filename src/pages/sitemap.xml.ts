import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import site from "../../site.config.ts";
import { getPosts } from "../lib/posts.ts";
import { absoluteUrl } from "../lib/format.ts";
import { readMediaMeta } from "../../shared/media.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Url {
  loc: string;
  lastmod?: Date;
  images?: string[];
}

export const GET: APIRoute = async () => {
  const posts = await getPosts();
  const pages = await getCollection("pages");
  const newest = (list: typeof posts) => list.reduce<Date | undefined>((d, p) => (!d || p.updated > d ? p.updated : d), undefined);

  const urls: Url[] = [
    { loc: "/", lastmod: newest(posts) },
    ...site.categories.map((c) => ({ loc: `/category/${c.slug}/`, lastmod: newest(posts.filter((p) => p.category.slug === c.slug)) })),
    ...posts.map((p) => {
      const cover = p.entry.data.cover ? readMediaMeta(p.entry.data.cover.src) : null;
      return { loc: p.url, lastmod: p.updated, images: cover ? [cover.src] : [] };
    }),
    ...pages.map((p) => ({ loc: `/${p.id}/`, lastmod: p.data.updated })),
  ];

  const body = urls
    .map((u) => {
      const parts = [`<loc>${esc(absoluteUrl(u.loc))}</loc>`];
      if (u.lastmod) parts.push(`<lastmod>${u.lastmod.toISOString()}</lastmod>`);
      for (const img of u.images ?? []) parts.push(`<image:image><image:loc>${esc(absoluteUrl(img))}</image:loc></image:image>`);
      return `<url>${parts.join("")}</url>`;
    })
    .join("\n");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${body}\n</urlset>\n`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } }
  );
};
