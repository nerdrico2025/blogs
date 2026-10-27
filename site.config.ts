/**
 * Carrega a configuração do blog escolhido pela variável SITE (pasta sites/<SITE>/).
 * Sem SITE, usa o blog de exemplo. SITE_URL sobrepõe o domínio da config.
 * Todo o código importa este arquivo; a configuração de cada blog fica em sites/<nome>/site.config.ts.
 */
import type { SiteConfig } from "./src/lib/config-schema.ts";
import { siteId } from "./src/lib/site-id.ts";

const mod = (await import(`./sites/${siteId()}/site.config.ts`)) as { default: SiteConfig };
const config: SiteConfig = { ...mod.default };

if (process.env.SITE_URL) {
  const url = process.env.SITE_URL.replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(url)) throw new Error(`SITE_URL inválida: ${process.env.SITE_URL} (use https://dominio, sem caminho).`);
  config.url = url;
}

export default config;
