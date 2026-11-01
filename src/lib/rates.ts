import site from "../../site.config.ts";
import { cached, fetchText } from "./remote-cache.ts";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

let pending: Promise<{ label: string; value: string }[]> | null = null;

/** Cotações do ticker: buscadas no build (cache de 1 h) ou os valores fixos da config. */
export function tickerRates(): Promise<{ label: string; value: string }[]> {
  pending ??= load();
  return pending;
}

async function load(): Promise<{ label: string; value: string }[]> {
  const { rates, ratesSource } = site.ticker;
  if (ratesSource !== "awesomeapi" || rates.length === 0) return rates;
  const pairs = rates.map((r) => `${r.code}-BRL`).join(",");
  const data = await cached("rates", 3600_000, async () => {
    const json = JSON.parse(await fetchText(`https://economia.awesomeapi.com.br/json/last/${pairs}`)) as Record<string, { bid: string }>;
    return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, Number(v.bid)]));
  });
  // Sem cotação e sem valor de reserva, a moeda fica de fora em vez de aparecer em branco
  return rates
    .map((r) => {
      const bid = data?.[`${r.code}BRL`];
      return { label: r.label, value: bid && Number.isFinite(bid) ? brl.format(bid) : r.value };
    })
    .filter((r) => r.value);
}
