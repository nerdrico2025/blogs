import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import type { Plugin } from "vite";
import site from "./site.config.ts";
import { rehypeBlog } from "./src/markdown/rehype-blog.ts";
import { siteDir, siteId } from "./src/lib/site-id.ts";
import { uploadsRoot } from "./shared/media.ts";
import { assetsRoot } from "./shared/settings.ts";

/** Em `astro dev` e `astro preview`, serve /wp-content/uploads a partir do UPLOADS_DIR (em produção quem serve é a API). */
function serveUploads(): Plugin {
  const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml" };
  const handlerFor = (root: string) => (req: { url?: string }, res: import("node:http").ServerResponse, next: () => void) => {
    const rel = decodeURIComponent((req.url ?? "").split("?")[0]!);
    const file = path.join(root, rel);
    if (!file.startsWith(root) || file.includes(`${path.sep}originais${path.sep}`) || !existsSync(file) || !statSync(file).isFile() || file.endsWith(".json")) return next();
    res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
    createReadStream(file).pipe(res);
  };
  return {
    name: "blog-serve-uploads",
    configureServer: (server) => {
      server.middlewares.use("/wp-content/uploads", handlerFor(uploadsRoot()));
      server.middlewares.use("/assets", handlerFor(assetsRoot()));
    },
    configurePreviewServer: (server) => {
      server.middlewares.use("/wp-content/uploads", handlerFor(uploadsRoot()));
      server.middlewares.use("/assets", handlerFor(assetsRoot()));
    },
  };
}

export default defineConfig({
  site: site.url,
  trailingSlash: "always",
  publicDir: path.join(siteDir(), "public"),
  cacheDir: `./node_modules/.astro/${siteId()}`,
  build: { format: "directory", inlineStylesheets: "always" },
  compressHTML: true,
  markdown: {
    processor: unified({
      rehypePlugins: [[rehypeBlog, { wordsPerMinute: site.article.wordsPerMinute }]],
    }),
  },
  vite: { plugins: [serveUploads()] },
});
