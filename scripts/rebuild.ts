/** Pede um build ao servidor em execução (use pelo console do container). Uso: npm run rebuild */
const port = process.env.PORT ?? process.env.API_PORT ?? "8787";
const res = await fetch(`http://127.0.0.1:${port}/internal/rebuild?reason=console`, { method: "POST" });
console.log(res.ok ? "Build pedido. Acompanhe em /health (campo build)." : `Falhou: HTTP ${res.status}`);
process.exit(res.ok ? 0 : 1);

export {};
