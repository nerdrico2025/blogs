/**
 * IP real do visitante, para o rate limit e o bloqueio por falhas de login.
 * - Atrás do Traefik (Easypanel): o Fastify confia em TRUST_PROXY saltos e lê o X-Forwarded-For.
 * - Com a Cloudflare na frente (nuvem laranja): quem conecta é a Cloudflare, e o IP do visitante
 *   vem em CF-Connecting-IP. Esse cabeçalho só é aceito quando a conexão vem de um IP da Cloudflare;
 *   do contrário, qualquer um poderia forjá-lo para escapar do rate limit.
 */
import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";

// https://www.cloudflare.com/ips/ (sobreponha com CLOUDFLARE_IPS="cidr,cidr" se a lista mudar)
const DEFAULT_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32",
];

const cloudflare = new BlockList();
for (const cidr of (process.env.CLOUDFLARE_IPS?.split(",") ?? DEFAULT_RANGES).map((s) => s.trim()).filter(Boolean)) {
  const [net, bits] = cidr.split("/");
  const type = isIP(net!) === 6 ? "ipv6" : "ipv4";
  cloudflare.addSubnet(net!, Number(bits), type);
}

function normalize(ip: string): string {
  return ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

export function isCloudflare(ip: string): boolean {
  const n = normalize(ip);
  const type = isIP(n);
  return type !== 0 && cloudflare.check(n, type === 6 ? "ipv6" : "ipv4");
}

export function clientIp(req: FastifyRequest): string {
  const proxied = normalize(req.ip);
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && isIP(cf.trim()) && isCloudflare(proxied)) return normalize(cf.trim());
  return proxied;
}
