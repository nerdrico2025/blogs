import site from "../../site.config.ts";

const dateFmt = new Intl.DateTimeFormat(site.lang, { day: "numeric", month: "long", year: "numeric", timeZone: site.timezone });
const shortFmt = new Intl.DateTimeFormat(site.lang, { day: "2-digit", month: "short", year: "numeric", timeZone: site.timezone });

export const formatDate = (d: Date) => dateFmt.format(d);
export const formatShortDate = (d: Date) => shortFmt.format(d).replace(/\./g, "");
export const isoDate = (d: Date) => d.toISOString();

export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return site.url + (path.startsWith("/") ? path : `/${path}`);
}

/** /category/x/ + página → /category/x/page/2/ (página 1 sem sufixo). */
export function pageUrl(base: string, page: number): string {
  const b = base.endsWith("/") ? base : `${base}/`;
  return page <= 1 ? b : `${b}page/${page}/`;
}
