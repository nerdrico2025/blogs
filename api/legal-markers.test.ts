/**
 * Marcadores legais ({{legal.razaoSocial}}, {{legal.cnpj}}, {{legal.cidade}}) sem dado no site.config.ts.
 * Só avisa (não falha): lista, por blog, os marcadores usados nas páginas fixas que ainda estão pendentes.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

process.env.SITE = "nerdrico";
const { LEGAL_MARKERS, PENDING, fillPlaceholders } = await import("../src/lib/placeholders.ts");

describe("marcadores legais", () => {
  test("dado não informado aparece como '(… a informar)', sem inventar", () => {
    assert.equal(fillPlaceholders("{{legal.cnpj}}"), PENDING("CNPJ"));
    assert.equal(fillPlaceholders("{{legal.razaoSocial}}"), PENDING("razão social"));
    assert.equal(fillPlaceholders("{{legal.cidade}}"), PENDING("cidade"));
  });

  test("pendências por blog (aviso, não falha)", async (t) => {
    const pending: string[] = [];
    for (const blog of readdirSync("sites")) {
      const cfgFile = path.resolve("sites", blog, "site.config.ts");
      const pagesDir = path.join("sites", blog, "pages");
      if (!existsSync(cfgFile) || !existsSync(pagesDir)) continue;
      const cfg = (await import(cfgFile)).default as { legal: { city: string; razaoSocial?: string; cnpj?: string } };
      for (const f of readdirSync(pagesDir).filter((x) => x.endsWith(".md"))) {
        const used = new Set([...readFileSync(path.join(pagesDir, f), "utf8").matchAll(/\{\{\s*(legal\.[a-zA-Z]+)\s*\}\}/g)].map((m) => m[1]!));
        for (const key of used) if (LEGAL_MARKERS[key] && !LEGAL_MARKERS[key](cfg)) pending.push(`${blog}/pages/${f}: {{${key}}}`);
      }
    }
    for (const p of pending) t.diagnostic(`pendente: ${p}`);
    if (pending.length) console.log(`Aviso: ${pending.length} marcador(es) legal(is) sem dado:\n  ${pending.join("\n  ")}`);
    assert.ok(true);
  });
});
