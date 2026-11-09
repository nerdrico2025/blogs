import site from "../../site.config.ts";

/** Dado legal ainda não informado: aparece assim na página, para ninguém achar que é o dado real. */
export const PENDING = (what: string) => `(${what} a informar)`;

const values: Record<string, string> = {
  "site.name": site.name,
  "site.url": site.url,
  "site.domain": new URL(site.url).host,
  "contact.email": site.contact.email,
  "legal.owner": site.legal.owner,
  "legal.city": site.legal.city || PENDING("cidade"),
  "legal.cidade": site.legal.city || PENDING("cidade"),
  "legal.razaoSocial": site.legal.razaoSocial?.trim() || PENDING("razão social"),
  "legal.cnpj": site.legal.cnpj?.trim() || PENDING("CNPJ"),
};

/** Marcadores legais que dependem de dado que o blog ainda não informou (para o aviso dos testes). */
export const LEGAL_MARKERS: Record<string, (s: { legal: { city: string; razaoSocial?: string; cnpj?: string } }) => boolean> = {
  "legal.cidade": (s) => Boolean(s.legal.city?.trim()),
  "legal.city": (s) => Boolean(s.legal.city?.trim()),
  "legal.razaoSocial": (s) => Boolean(s.legal.razaoSocial?.trim()),
  "legal.cnpj": (s) => Boolean(s.legal.cnpj?.trim()),
};

/** Troca {{site.name}}, {{contact.email}} etc. pelos valores do site.config.ts. */
export function fillPlaceholders(text: string): string {
  // Também aceita a forma codificada em URLs (%7B%7Bchave%7D%7D), ex.: mailto:{{contact.email}}
  return text.replace(/(?:\{\{|%7B%7B)\s*([a-z.]+)\s*(?:\}\}|%7D%7D)/gi, (m, key: string) => {
    if (!(key in values)) throw new Error(`Marcador desconhecido: ${m}`);
    return values[key]!;
  });
}
