/** Erros no formato da WordPress REST API: {"code", "message", "data": {"status"}}. */
export class WpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  toJSON() {
    return { code: this.code, message: this.message, data: { status: this.status } };
  }
}

export const badParam = (param: string, message: string) => new WpError(400, "rest_invalid_param", `Parâmetro inválido: ${param}. ${message}`);
