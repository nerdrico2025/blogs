import site from "../../site.config.ts";

const values: Record<string, string> = {
  "site.name": site.name,
  "site.url": site.url,
  "site.domain": new URL(site.url).host,
  "contact.email": site.contact.email,
  "legal.owner": site.legal.owner,
  "legal.city": site.legal.city,
};

/** Troca {{site.name}}, {{contact.email}} etc. pelos valores do site.config.ts. */
export function fillPlaceholders(text: string): string {
  // Também aceita a forma codificada em URLs (%7B%7Bchave%7D%7D), ex.: mailto:{{contact.email}}
  return text.replace(/(?:\{\{|%7B%7B)\s*([a-z.]+)\s*(?:\}\}|%7D%7D)/gi, (m, key: string) => {
    if (!(key in values)) throw new Error(`Marcador desconhecido: ${m}`);
    return values[key]!;
  });
}
