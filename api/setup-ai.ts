/** Passo 2 do assistente: a IA propõe categorias, textos e paleta. A chave nunca vai para logs. */
import Anthropic from "@anthropic-ai/sdk";
import { ensureReadable, isHex } from "../shared/settings.ts";
import { WpError } from "./errors.ts";
import { validSlug } from "./settings-store.ts";

export interface SetupProposal {
  categories: { name: string; slug: string; description: string }[];
  authorName: string;
  authorBio: string;
  about: string;
  tagline: string;
  palette: { primary: string; highlight: string; callout: string };
}

const strObject = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const SCHEMA = strObject({
  categories: { type: "array", items: strObject({ name: { type: "string" }, slug: { type: "string" }, description: { type: "string" } }) },
  authorName: { type: "string" },
  authorBio: { type: "string" },
  about: { type: "string" },
  tagline: { type: "string" },
  palette: strObject({ primary: { type: "string" }, highlight: { type: "string" }, callout: { type: "string" } }),
});

const SYSTEM = `Você prepara a identidade inicial de um blog novo. Responda no idioma pedido.
- categories: de 5 a 7 categorias amplas, que comportem muitos artigos e não se sobreponham. name curto; slug em minúsculas, sem acento, só letras, números e hífen; description de SEO com no máximo 160 caracteres.
- authorName: nome editorial genérico (por exemplo, "Equipe <nome do blog>"), sem inventar uma pessoa.
- authorBio: de 1 a 2 frases, sem inventar credenciais.
- about: texto da página Sobre em Markdown, de 2 a 4 parágrafos curtos, sem inventar fatos, números, prêmios ou equipe.
- tagline: uma frase com até 70 caracteres.
- palette: cores em hexadecimal #rrggbb combinando com o nicho. primary, highlight e callout precisam ter contraste de pelo menos 4,5:1 com branco.`;

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
  for (const key of ["authorName", "authorBio", "about", "tagline"] as const) if (!p[key]?.trim()) errors.push(`${key} vazio`);
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
    if (lastErrors.length === 0) return parsed;
  }
  throw new WpError(502, "ai_invalid", "A IA devolveu sugestões incompletas. Clique em tentar de novo.");
}
