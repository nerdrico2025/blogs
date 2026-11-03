/**
 * Cliente da API do blog: as mesmas rotas compatíveis com WordPress que o Wordbee usa
 * (api/server.ts), mais GET /posts?slug= e POST /posts/:id para a reimportação atualizar.
 */
import { USER_AGENT } from "./source.ts";

export interface BlogCategory {
  id: number;
  name: string;
  slug: string;
}

export interface BlogMedia {
  id: number;
  source_url: string;
}

export interface BlogPost {
  id: number;
  slug: string;
  link: string;
}

export class BlogApi {
  readonly rest: string;
  private readonly auth: string | null;

  constructor(base: string, user?: string, password?: string) {
    const u = new URL(base);
    this.rest = `${u.origin}${u.pathname.replace(/\/$/, "")}/wp-json/wp/v2`;
    this.auth = user && password ? "Basic " + Buffer.from(`${user}:${password}`).toString("base64") : null;
  }

  /**
   * Confere se o destino é um blog deste motor (GET /health), e não outro WordPress: com o domínio
   * ainda apontando para o site antigo, a URL do site.config.ts responde pelo WordPress antigo.
   */
  async checkEngine(): Promise<{ site: string }> {
    const url = this.rest.replace(/\/wp-json\/wp\/v2$/, "/health");
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new Error(`${url} não respondeu (${(err as Error).message})`);
    }
    const data = (await res.json().catch(() => null)) as { status?: string; site?: string } | null;
    if (!res.ok || data?.status !== "ok" || typeof data.site !== "string") {
      throw new Error(`${url} não é um blog deste projeto (o domínio ainda aponta para o WordPress antigo?)`);
    }
    return { site: data.site };
  }

  get hasAuth(): boolean {
    return this.auth !== null;
  }

  /** Repete em erro de rede e espera o tempo pedido no 429 (limite de requisições por minuto da API). */
  private async call<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<{ status: number; data: T; headers: Headers }> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.rest + path, {
          ...init,
          headers: { "User-Agent": USER_AGENT, ...(this.auth ? { Authorization: this.auth } : {}), ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt >= 3) throw new Error(`${init.method ?? "GET"} ${path}: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      const text = await res.text();
      if (res.status === 429 && attempt < 6) {
        const wait = Number(res.headers.get("retry-after") ?? 30);
        console.log(`  … limite de requisições da API do blog; esperando ${wait} s`);
        await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
        continue;
      }
      if (!res.ok) {
        let message = text.slice(0, 200);
        try {
          message = (JSON.parse(text) as { message?: string }).message ?? message;
        } catch {}
        throw new Error(`${init.method ?? "GET"} ${path} → HTTP ${res.status}: ${message}`);
      }
      return { status: res.status, data: JSON.parse(text) as T, headers: res.headers };
    }
  }

  async categories(): Promise<BlogCategory[]> {
    return (await this.call<BlogCategory[]>("/categories?per_page=100&orderby=name&order=asc")).data;
  }

  async checkAuth(): Promise<void> {
    await this.call("/users/me?context=edit");
  }

  async findPost(slug: string): Promise<BlogPost | null> {
    const { data } = await this.call<BlogPost[]>(`/posts?slug=${encodeURIComponent(slug)}`);
    return data[0] ?? null;
  }

  async uploadMedia(data: Buffer, type: string, filename: string, alt: string): Promise<BlogMedia> {
    const ascii = filename.replace(/[^\w.-]+/g, "-");
    const { data: media } = await this.call<BlogMedia>(
      `/media?alt_text=${encodeURIComponent(alt)}`,
      {
        method: "POST",
        headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}` },
        body: new Uint8Array(data),
      },
      60_000
    );
    return media;
  }

  async createPost(body: Record<string, unknown>): Promise<{ created: boolean; post: BlogPost }> {
    const { status, data } = await this.call<BlogPost>("/posts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { created: status === 201, post: data };
  }

  async updatePost(id: number, body: Record<string, unknown>): Promise<{ changed: boolean; post: BlogPost }> {
    const { data, headers } = await this.call<BlogPost>(`/posts/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { changed: headers.get("x-post-changed") !== "0", post: data };
  }
}
