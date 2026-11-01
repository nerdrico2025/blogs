/** Passo 2 do assistente: a IA propõe categorias, textos e paleta. A chave nunca vai para logs. */
import Anthropic from "@anthropic-ai/sdk";
import { ensureReadable, isHex, type HomeSettings } from "../shared/settings.ts";
import { WpError } from "./errors.ts";
import { HOME_LIMITS, parseHome, validSlug } from "./settings-store.ts";

export interface SetupProposal {
  categories: { name: string; slug: string; description: string }[];
  about: string;
  tagline: string;
  /** Orientação sobre o especialista ideal. Só aparece na revisão; nunca é publicada. */
  expertProfile?: string;
  palette: { primary: string; highlight: string; callout: string };
  /** null: a IA não gerou blocos válidos, e eles ficam desligados. */
  home?: HomeSettings | null;
}

const strObject = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const LINK = strObject({ label: { type: "string" }, href: { type: "string" } });
const SCHEMA = strObject({
  categories: { type: "array", items: strObject({ name: { type: "string" }, slug: { type: "string" }, description: { type: "string" } }) },
  expertProfile: { type: "string" },
  about: { type: "string" },
  tagline: { type: "string" },
  palette: strObject({ primary: { type: "string" }, highlight: { type: "string" }, callout: { type: "string" } }),
  home: strObject({
    tools: strObject({
      title: { type: "string" },
      text: { type: "string" },
      items: { type: "array", items: strObject({ icon: { type: "string" }, label: { type: "string" }, href: { type: "string" } }) },
      button: LINK,
    }),
    callout: strObject({ kicker: { type: "string" }, title: { type: "string" }, text: { type: "string" }, button: LINK }),
    footerText: { type: "string" },
    searchPlaceholder: { type: "string" },
  }),
});

const SYSTEM = `Você prepara a identidade inicial de um blog novo. Responda no idioma pedido.
- categories: de 5 a 7 categorias amplas, que comportem muitos artigos e não se sobreponham. name curto; slug em minúsculas, sem acento, só letras, números e hífen; description de SEO com no máximo 160 caracteres.
- expertProfile: orientação em até 600 caracteres sobre o perfil ideal de especialista para assinar este nicho: área de atuação e tipo de experiência. Descreva o perfil, nunca uma pessoa: sem nomes, fotos, credenciais específicas, instituições ou links.
- about: texto da página Sobre em Markdown, de 2 a 4 parágrafos curtos, sem inventar fatos, números, prêmios ou equipe.
- tagline: uma frase com até 70 caracteres.
- palette: cores em hexadecimal #rrggbb combinando com o nicho. primary, highlight e callout precisam ter contraste de pelo menos 4,5:1 com branco.
- home: blocos da barra lateral e do rodapé, adequados ao nicho, em texto puro, sem HTML.
  - tools: caixa de recursos. title com até ${HOME_LIMITS.title} caracteres; text (descrição) com até ${HOME_LIMITS.text}; exatamente 5 items, cada um com icon (um emoji), label com até ${HOME_LIMITS.label} caracteres e href; button com label de até ${HOME_LIMITS.buttonLabel} caracteres e href.
  - callout: caixa de destaque. kicker (etiqueta) com até ${HOME_LIMITS.kicker} caracteres, title, text e button, com os mesmos limites.
  - footerText: uma frase de rodapé com até ${HOME_LIMITS.footer} caracteres, sem inventar fatos.
  - searchPlaceholder: exemplo de busca com até ${HOME_LIMITS.placeholder} caracteres.
  - Todo href é interno: /category/<slug de uma das categories>/ ou /sobre/. Nunca invente endereços externos, marcas parceiras ou links de afiliado.`;

const HOME_TEXT_KEYS = ["footerText", "searchPlaceholder"] as const;
const hasMarkup = (v: unknown): boolean => {
  if (typeof v === "string") return /[<>]/.test(v);
  if (Array.isArray(v)) return v.some(hasMarkup);
  return Boolean(v) && typeof v === "object" && Object.values(v as object).some(hasMarkup);
};

function homeHrefs(home: HomeSettings): string[] {
  return [...(home.tools?.items ?? []).flatMap((it) => (it.href ? [it.href] : [])), home.tools?.button.href ?? "", home.callout?.button.href ?? ""].filter(Boolean);
}

/** Links internos para /category/<slug>/ que não batem com nenhuma categoria. */
export function brokenCategoryLinks(home: HomeSettings, slugs: string[]): string[] {
  return homeHrefs(home).filter((h) => {
    const slug = h.match(/^\/category\/([^/?#]+)/)?.[1];
    return slug !== undefined && !slugs.includes(slug);
  });
}

/**
 * Regras só para o que vem da IA: limites do painel, sem HTML, e links apenas internos e existentes,
 * para ela não inventar endereço de parceiro. Links externos são colocados por quem revisa.
 * Devolve os problemas; sem problemas, troca `home` pela versão normalizada, com as caixas ligadas.
 */
export function validateAiHome(p: SetupProposal): string[] {
  const raw = p.home as unknown as { tools?: { items?: unknown[] }; callout?: unknown; footerText?: string; searchPlaceholder?: string } | null | undefined;
  if (!raw?.tools || !raw.callout) return ["home incompleto"];
  if (hasMarkup(raw)) return ["os textos de home não podem ter HTML"];
  let home: HomeSettings;
  try {
    home = parseHome({ tools: { ...raw.tools, enabled: true }, callout: { ...(raw.callout as object), enabled: true }, footerText: raw.footerText ?? "", searchPlaceholder: raw.searchPlaceholder ?? "" });
  } catch (err) {
    return [err instanceof Error ? err.message : "home inválido"];
  }
  const errors: string[] = [];
  if (home.tools?.items.length !== 5) errors.push("a caixa de recursos precisa de exatamente 5 itens");
  if (!home.tools?.button.href || !home.callout?.button.href) errors.push("as duas caixas precisam de botão");
  if (!home.callout?.text || !home.tools?.text) errors.push("as duas caixas precisam de texto");
  for (const key of HOME_TEXT_KEYS) if (!home[key]) errors.push(`${key} vazio`);
  const hrefs = homeHrefs(home);
  const slugs = p.categories.map((c) => c.slug);
  if (hrefs.some((h) => h !== "/sobre/" && !h.startsWith("/category/"))) errors.push("os links de home só podem ser /sobre/ ou /category/<slug>/");
  errors.push(...brokenCategoryLinks(home, slugs).map((h) => `o link ${h} não é de uma categoria proposta`));
  if (errors.length === 0) p.home = home;
  return errors;
}

/** Valida a resposta e devolve a lista de problemas (vazia = ok). Ajusta só o contraste. */
export function validateProposal(p: SetupProposal): string[] {
  const errors: string[] = [];
  if (!Array.isArray(p.categories) || p.categories.length < 5 || p.categories.length > 7) errors.push("são de 5 a 7 categorias");
  const slugs = new Set<string>();
  for (const c of p.categories ?? []) {
    if (!c.name?.trim()) errors.push("categoria sem nome");
    if (!validSlug(c.slug) || slugs.has(c.slug)) errors.push(`slug inválido ou repetido: ${c.slug}`);
    slugs.add(c.slug);
    if (!c.description?.trim() || c.description.length > 160) errors.push(`descrição de "${c.name}" precisa ter de 1 a 160 caracteres`);
  }
  for (const key of ["about", "tagline"] as const) if (!p[key]?.trim()) errors.push(`${key} vazio`);
  for (const key of ["primary", "highlight", "callout"] as const) {
    if (!isHex(p.palette?.[key])) errors.push(`cor ${key} inválida`);
    else p.palette[key] = ensureReadable(p.palette[key]);
  }
  return errors;
}

function friendly(err: unknown): WpError {
  const fail = (msg: string) => new WpError(502, "ai_error", msg);
  if (err instanceof Anthropic.AuthenticationError) return fail("A chave da IA (ANTHROPIC_API_KEY) foi recusada. Confira a variável no Easypanel.");
  if (err instanceof Anthropic.PermissionDeniedError) return fail("Esta chave da IA não tem permissão para usar o modelo escolhido.");
  if (err instanceof Anthropic.NotFoundError) return fail("O modelo definido em AI_MODEL não existe. Confira a variável.");
  if (err instanceof Anthropic.RateLimitError) return fail("A IA está no limite de uso desta conta. Espere um minuto e tente de novo.");
  if (err instanceof Anthropic.BadRequestError) return fail("A IA recusou o pedido (verifique se há crédito na conta e se AI_MODEL é um modelo atual).");
  if (err instanceof Anthropic.APIConnectionError) return fail("Não foi possível falar com a IA. Verifique a internet do servidor e tente de novo.");
  if (err instanceof Anthropic.APIError) return fail("A IA ficou indisponível. Tente de novo em instantes.");
  return fail("Não foi possível gerar as sugestões. Tente de novo.");
}

/** Fallback no servidor em caso de recusa, só nos modelos que aceitam a opção. */
const FALLBACK_MODELS = /^claude-(opus-5|fable-5|sonnet-5-5)/;

export async function generateProposal(input: { name: string; niche: string; lang: string; apiKey: string; model: string }): Promise<SetupProposal> {
  const client = new Anthropic({ apiKey: input.apiKey, timeout: 180_000, maxRetries: 2 });
  const user = `Nome do blog: ${input.name}\nNicho: ${input.niche}\nIdioma: ${input.lang}`;
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = attempt === 0 ? user : `${user}\n\nA tentativa anterior foi recusada porque: ${lastErrors.join("; ")}. Corrija.`;
    let response;
    try {
      response = await client.beta.messages.create({
        model: input.model,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [{ role: "user", content }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
        ...(FALLBACK_MODELS.test(input.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      } as never);
    } catch (err) {
      throw friendly(err);
    }
    const message = response as unknown as Anthropic.Message;
    if (message.stop_reason === "refusal") throw new WpError(502, "ai_refused", "A IA não quis gerar sugestões para este nicho. Reformule o nicho e tente de novo.");
    if (message.stop_reason === "max_tokens") {
      lastErrors = ["a resposta ficou longa demais"];
      continue;
    }
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let parsed: SetupProposal;
    try {
      parsed = JSON.parse(text) as SetupProposal;
    } catch {
      lastErrors = ["a resposta não era um JSON válido"];
      continue;
    }
    lastErrors = validateProposal(parsed);
    if (lastErrors.length > 0) continue;
    // Só orientação: se vier fora do combinado, a revisão fica sem ela, sem refazer o pedido
    const expert = typeof parsed.expertProfile === "string" ? parsed.expertProfile.trim() : "";
    parsed.expertProfile = expert.length <= 600 && !/[<>]/.test(expert) && !/https?:/i.test(expert) ? expert : "";
    const homeErrors = validateAiHome(parsed);
    if (homeErrors.length === 0) return parsed;
    // O essencial está bom: sem blocos válidos na segunda tentativa, o blog publica com eles desligados
    if (attempt === 1) return { ...parsed, home: null };
    lastErrors = homeErrors;
  }
  throw new WpError(502, "ai_invalid", "A IA devolveu sugestões incompletas. Clique em tentar de novo.");
}
