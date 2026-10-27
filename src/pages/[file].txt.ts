import type { APIRoute, GetStaticPaths } from "astro";
import site from "../../site.config.ts";

/** /ads.txt só é gerado quando `adsTxt` tem linhas no site.config.ts. */
export const getStaticPaths = (() => (site.adsTxt.length ? [{ params: { file: "ads" } }] : [])) satisfies GetStaticPaths;

export const GET: APIRoute = () =>
  new Response(site.adsTxt.join("\n") + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
