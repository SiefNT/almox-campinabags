// API do app de almoxarifado: tudo em /api/*
import {
  config as lerConfig, ErroApp, verificarToken, login, buscar, publico, produtoAtual, produtoDoCache,
  movimentar, ultimos, csvDoMes, infoLista, baixarProdutos, agoraBR,
} from "../lib/core.mjs";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

export default async (req) => {
  const url = new URL(req.url);
  const rota = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const cfg = lerConfig();
  try {
    if (rota === "login" && req.method === "POST") {
      const d = await req.json().catch(() => ({}));
      return json(await login(cfg, d.nome, d.pin));
    }

    // Daqui para baixo precisa estar logado.
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("t");
    const sessao = verificarToken(cfg, token);
    if (!sessao) return json({ erro: "Sessão expirada. Entre de novo.", login: true }, 401);

    if (req.method === "GET") {
      if (rota === "status") {
        return json({ ...(await infoLista(cfg)), operador: sessao.nome,
          libera_todos: cfg.liberaTodos, liberados: [...cfg.liberados].sort() });
      }
      if (rota === "buscar") {
        const itens = await buscar(cfg, url.searchParams.get("q"));
        return json({ itens: itens.map((p) => publico(cfg, p)) });
      }
      if (rota.startsWith("produto/")) {
        const id = rota.split("/")[1];
        try {
          return json({ produto: publico(cfg, await produtoAtual(cfg, id)), ao_vivo: true });
        } catch (e) {
          const p = await produtoDoCache(cfg, id);
          if (!p) throw e;
          return json({ produto: publico(cfg, p), ao_vivo: false, aviso: e.message });
        }
      }
      if (rota === "movimentos") return json({ movimentos: await ultimos(15) });
      if (rota === "movimentos.csv") {
        const mes = url.searchParams.get("mes") || agoraBR().mes;
        return new Response(await csvDoMes(mes), { headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="almox-${mes}.csv"`,
          "Cache-Control": "no-store",
        } });
      }
    }

    if (req.method === "POST") {
      if (rota === "movimento") {
        const d = await req.json().catch(() => ({}));
        return json(await movimentar(cfg, sessao.nome, d));
      }
      if (rota === "atualizar-produtos") {
        const n = await baixarProdutos(cfg);
        return json({ ok: true, produtos: n });
      }
    }
    return json({ erro: `Rota não encontrada: ${req.method} /api/${rota}` }, 404);
  } catch (e) {
    const status = e instanceof ErroApp ? e.status : 500;
    console.error(`[api] ${req.method} /api/${rota} -> ${status}: ${e.message}`);
    return json({ ok: false, erro: e instanceof ErroApp ? e.message : `Erro interno: ${e.message}`, ...(e.extra || {}) }, status);
  }
};

export const config = { path: "/api/*" };
