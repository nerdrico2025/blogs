/** Caminhos de primeiro nível que não podem ser usados como slug de post ou página. */
export const RESERVED_SLUGS = new Set([
  "category", "page", "search", "feed", "wp-json", "wp-admin", "wp-content", "uploads",
  "fonts", "brand", "pagefind", "_astro", "404", "sitemap.xml", "robots.txt", "ads.txt", "feed.xml", "health", "api",
]);
