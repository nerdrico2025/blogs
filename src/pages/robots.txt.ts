import type { APIRoute } from "astro";
import site from "../../site.config.ts";

export const GET: APIRoute = () =>
  new Response(
    ["User-agent: *", "Allow: /", "Disallow: /search/", "Disallow: /wp-json/", "", `Sitemap: ${site.url}/sitemap.xml`, ""].join("\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
