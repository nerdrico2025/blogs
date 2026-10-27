/**
 * Upload para armazenamento S3-compatível (ex.: Contabo Object Storage) com AWS Signature V4,
 * sem SDK. URL no estilo caminho: <endpoint>/<bucket>/<chave>. Corpo enviado em streaming
 * (UNSIGNED-PAYLOAD, aceito pelo S3 em HTTPS).
 */
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import type { S3Config } from "./env.ts";

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** Codifica cada segmento do caminho como o S3 espera (RFC 3986). */
const encodePath = (p: string) =>
  p.split("/").map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

export interface SignInput {
  method: string;
  url: URL;
  region: string;
  service: string;
  /** Cabeçalhos a assinar (o host entra automaticamente). */
  headers: Record<string, string>;
  payloadHash: string;
  accessKey: string;
  secretKey: string;
  /** Formato AAAAMMDDTHHMMSSZ */
  amzDate: string;
}

export function signV4(input: SignInput): string {
  const date = input.amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: input.url.host };
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join("&");
  const canonical = [input.method, encodePath(decodeURIComponent(input.url.pathname)), query, canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretKey}`, date), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export async function uploadFile(cfg: S3Config, file: string, key: string): Promise<void> {
  const size = (await stat(file)).size;
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${encodePath(key)}`);
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const signed = { "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": amzDate };
  const authorization = signV4({
    method: "PUT", url, region: cfg.region, service: "s3", headers: signed,
    payloadHash: "UNSIGNED-PAYLOAD", accessKey: cfg.accessKey, secretKey: cfg.secretKey, amzDate,
  });
  const send = url.protocol === "https:" ? request : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const req = send(url, { method: "PUT", headers: { ...signed, authorization, "content-length": size, "content-type": "application/gzip" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => ((res.statusCode ?? 500) < 300 ? resolve() : reject(new Error(`S3 respondeu ${res.statusCode}: ${body.slice(0, 300)}`))));
    });
    req.on("error", reject);
    req.setTimeout(10 * 60_000, () => req.destroy(new Error("tempo esgotado no upload do backup")));
    createReadStream(file).pipe(req);
  });
}
