import type { APIRoute } from "astro";
import site from "../../site.config.ts";
import { getPosts } from "../lib/posts.ts";
import { absoluteUrl } from "../lib/format.ts";
import { readMediaMeta, variantUrl } from "../../shared/media.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const GET: APIRoute = async () => {
  const posts = (await getPosts()).slice(0, 20);
  const items = posts
    .map((p) => {
      const meta = p.entry.data.cover ? readMediaMeta(p.entry.data.cover.src) : null;
      const img = meta ? absoluteUrl(variantUrl(meta, meta.widths.find((w) => w >= 768) ?? meta.widths.at(-1)!, "webp")) : null;
      const desc = (img ? `<p><img src="${img}" alt="${esc(p.entry.data.cover!.alt)}" /></p>` : "") + `<p>${esc(p.excerpt)}</p>`;
      return `<item>
  <title>${esc(p.title)}</title>
  <link>${absoluteUrl(p.url)}</link>
  <guid isPermaLink="true">${absoluteUrl(p.url)}</guid>
  <pubDate>${p.date.toUTCString()}</pubDate>
  <category>${esc(p.category.name)}</category>
  <dc:creator>${esc(p.author.name)}</dc:creator>
  <description><![CDATA[${desc}]]></description>${img ? `\n  <media:content url="${img}" medium="image" type="image/webp" />` : ""}
</item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>${esc(site.name)}</title>
  <link>${site.url}/</link>
  <description>${esc(site.description)}</description>
  <language>${site.lang.toLowerCase()}</language>
  <atom:link href="${site.url}/feed.xml" rel="self" type="application/rss+xml" />
  ${posts[0] ? `<lastBuildDate>${posts[0].updated.toUTCString()}</lastBuildDate>` : ""}
${items}
</channel>
</rss>
`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
};
