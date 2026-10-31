/**
 * Carrega a configuração do blog escolhido pela variável SITE (pasta sites/<SITE>/; sem pasta, o modelo
 * sites/_base/) e aplica por cima o settings.json editado no /admin. SITE_URL sobrepõe o domínio.
 * Todo o código importa este arquivo; a configuração de cada blog fica em sites/<nome>/site.config.ts.
 */
import { applySettings, readSettings, type Settings } from "./shared/settings.ts";
import type { SiteConfig } from "./src/lib/config-schema.ts";
import { hasSiteFolder, siteId } from "./src/lib/site-id.ts";

const folder = hasSiteFolder() ? siteId() : "_base";
const mod = (await import(`./sites/${folder}/site.config.ts`)) as { default: SiteConfig };
const base: SiteConfig = { ...mod.default };

if (process.env.SITE_URL) {
  const url = process.env.SITE_URL.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(url)) throw new Error(`SITE_URL inválida: ${process.env.SITE_URL} (use https://dominio, sem caminho).`);
  base.url = url;
}
if (folder === "_base") base.contact = { email: `contato@${new URL(base.url).hostname}` };

const config: SiteConfig = applySettings(base, readSettings());

/** A API muda as configurações sem reiniciar: o mesmo objeto é atualizado para todos que o importam. */
export function reloadSite(settings: Settings): void {
  Object.assign(config, applySettings(base, settings));
}

/** Os valores do site.config.ts, sem o settings.json. */
export const baseSite: SiteConfig = base;

export default config;
