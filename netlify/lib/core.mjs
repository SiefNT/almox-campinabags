// Núcleo do app de almoxarifado: vhsys, lista de produtos, login e lançamentos.
// Usado pela função da API e pela atualização agendada.

import { getStore } from "@netlify/blobs";
import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";

// ------------------------------------------------------------------ config

const env = (k, padrao = "") => (process.env[k] ?? padrao).toString().trim();

export function config() {
  const lib = env("ITENS_LIBERADOS");
  return {
    base: env("VHSYS_BASE_URL", "https://api.vhsys.com/v2").replace(/\/+$/, ""),
    access: env("VHSYS_ACCESS_TOKEN"),
    secret: env("VHSYS_SECRET_TOKEN"),
    partner: env("VHSYS_PARTNER_TOKEN"),
    liberaTodos: lib === "*",
    liberados: new Set(lib === "*" ? [] : lib.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)),
    operadores: lerOperadores(env("OPERADORES")),
  };
}

// OPERADORES=Gabriel:1234;Ana Paula:5678
function lerOperadores(txt) {
  const mapa = new Map();
  for (const parte of txt.split(/[;\n]/)) {
    const i = parte.lastIndexOf(":");
    if (i <= 0) continue;
    const nome = parte.slice(0, i).trim();
    const pin = parte.slice(i + 1).trim();
    if (nome && pin) mapa.set(normalizar(nome), { nome, pin });
  }
  return mapa;
}

export function liberado(cfg, cod) {
  return cfg.liberaTodos || cfg.liberados.has(String(cod || "").trim().toUpperCase());
}

// ------------------------------------------------------------------ utilidades

export function normalizar(t) {
  return String(t ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().split(/\s+/).filter(Boolean).join(" ");
}

export function num(v) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

// Formato brasileiro feito à mão (não depende dos dados de idioma do servidor).
export function br(n) {
  const v = Math.round(Number(n) * 10000) / 10000;
  const [int, dec] = Math.abs(v).toFixed(4).replace(/0+$/, "").replace(/\.$/, "").split(".");
  const milhar = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (v < 0 ? "-" : "") + milhar + (dec ? "," + dec : "");
}

const fmtBR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
export function agoraBR() {
  const p = Object.fromEntries(fmtBR.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return {
    texto: `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`,
    mes: `${p.year}-${p.month}`,
    ordem: `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`,
  };
}

export class ErroApp extends Error {
  constructor(msg, status = 400, extra = {}) { super(msg); this.status = status; this.extra = extra; }
}

const loja = () => getStore({ name: "almox", consistency: "strong" });

// ------------------------------------------------------------------ vhsys

export async function vhsys(cfg, metodo, caminho, corpo) {
  if (!cfg.access || !cfg.secret) throw new ErroApp("Tokens do vhsys não configurados no Netlify.", 500);
  const headers = {
    "access-token": cfg.access,
    "secret-access-token": cfg.secret,
    "Cache-Control": "no-cache",
    "User-Agent": "CampinaBags-Almox/2.0",
    "Content-Type": "application/json",
  };
  if (cfg.partner) headers["partner-token"] = cfg.partner;
  let r;
  try {
    r = await fetch(cfg.base + caminho, {
      method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    throw new ErroApp(`Sem conexão com o vhsys: ${e.message}`, 502);
  }
  const txt = await r.text();
  let d = {};
  try { d = txt ? JSON.parse(txt) : {}; } catch { d = { data: txt }; }
  if (!r.ok) {
    const msg = typeof d.data === "string" ? d.data : (d.message || txt);
    throw new ErroApp(`vhsys respondeu ${r.status}: ${String(msg).slice(0, 300)}`, r.status === 404 ? 422 : 502);
  }
  return d;
}

// ------------------------------------------------------------------ lista de produtos

const CAMPOS = ["id_produto", "cod_produto", "desc_produto", "codigo_barra_produto", "codigo_barras_internos",
  "unidade_produto", "estoque_produto", "minimo_produto", "localizacao_produto", "valor_custo_produto"];

let memo = null; // { lido: ms, dados, indice }

function indexar(dados) {
  const porId = new Map(), porCod = new Map(), porEan = new Map();
  for (const p of dados.produtos) {
    p._busca = normalizar(`${p.cod_produto || ""} ${p.desc_produto || ""}`);
    porId.set(String(p.id_produto), p);
    const cod = normalizar(p.cod_produto);
    if (cod && !porCod.has(cod)) porCod.set(cod, p);
    for (const campo of ["codigo_barra_produto", "codigo_barras_internos"]) {
      for (const e of String(p[campo] || "").split(/[;,]/)) {
        const ean = e.trim();
        if (ean && !porEan.has(ean)) porEan.set(ean, p);
      }
    }
  }
  return { porId, porCod, porEan };
}

export async function baixarProdutos(cfg) {
  const limite = 250, lote = 4;
  const produtos = [];
  for (let pagina = 0; ; pagina += lote) {
    const paginas = await Promise.all(Array.from({ length: lote }, (_, i) =>
      vhsys(cfg, "GET", `/produtos?limit=${limite}&offset=${(pagina + i) * limite}&lixeira=Nao`)
        .then((r) => r.data || [])));
    let fim = false;
    for (const p of paginas) {
      produtos.push(...p);
      if (p.length < limite) { fim = true; break; }
    }
    if (fim) break;
    if (pagina > 400) throw new ErroApp("Lista de produtos grande demais (verifique a paginação).", 500);
  }
  const enxuto = produtos.map((p) => Object.fromEntries(CAMPOS.map((k) => [k, p[k] ?? null])));
  const dados = { atualizado_em: agoraBR().texto, produtos: enxuto };
  await loja().setJSON("produtos", dados);
  memo = { lido: Date.now(), dados, indice: indexar(dados) };
  return enxuto.length;
}

async function lista(cfg) {
  if (memo && Date.now() - memo.lido < 10 * 60_000) return memo;
  const dados = await loja().get("produtos", { type: "json" });
  if (!dados) { await baixarProdutos(cfg); return memo; }
  memo = { lido: Date.now(), dados, indice: indexar(dados) };
  return memo;
}

export async function infoLista(cfg) {
  const m = await lista(cfg);
  return { produtos: m.dados.produtos.length, atualizado_em: m.dados.atualizado_em };
}

export async function buscar(cfg, q) {
  q = String(q || "").trim();
  if (!q) return [];
  const { dados, indice } = await lista(cfg);
  const exato = indice.porCod.get(normalizar(q)) || indice.porEan.get(q) || indice.porId.get(q);
  if (exato) return [exato];

  // Código cadastrado depois da última atualização da lista: pergunta direto ao vhsys.
  if (!/\s/.test(q) || /\d/.test(q)) {
    try {
      const r = await vhsys(cfg, "GET", `/produtos?cod_produto=${encodeURIComponent(q)}&lixeira=Nao&limit=10`);
      const achado = (r.data || []).find((p) => normalizar(p.cod_produto) === normalizar(q));
      if (achado) return [achado];
    } catch { /* segue para a busca por nome */ }
  }

  const palavras = normalizar(q).split(" ");
  const res = dados.produtos.filter((p) => palavras.every((w) => p._busca.includes(w)));
  res.sort((a, b) => (num(b.estoque_produto) > 0) - (num(a.estoque_produto) > 0)
    || String(a.desc_produto || "").localeCompare(String(b.desc_produto || ""), "pt-BR"));
  return res.slice(0, 40);
}

export function publico(cfg, p) {
  return {
    id: String(p.id_produto),
    cod: p.cod_produto || "",
    desc: String(p.desc_produto || "").trim(),
    ean: p.codigo_barra_produto || "",
    un: String(p.unidade_produto || "").trim().toUpperCase(),
    saldo: num(p.estoque_produto),
    minimo: num(p.minimo_produto),
    local: p.localizacao_produto || "",
    liberado: liberado(cfg, p.cod_produto),
  };
}

export async function produtoAtual(cfg, id) {
  if (!/^\d+$/.test(String(id))) throw new ErroApp("Produto inválido", 400);
  const r = await vhsys(cfg, "GET", `/produtos/${id}`);
  let d = r.data;
  if (Array.isArray(d)) d = d[0];
  if (!d) throw new ErroApp("Produto não encontrado no vhsys", 422);
  if (memo) {
    const atual = memo.indice.porId.get(String(id));
    if (atual) for (const k of CAMPOS) if (k in d) atual[k] = d[k];
  }
  return d;
}

export async function produtoDoCache(cfg, id) {
  const { indice } = await lista(cfg);
  return indice.porId.get(String(id)) || null;
}

// ------------------------------------------------------------------ login (PIN por operador)

function chaveSessao(cfg) {
  const extra = env("SEGREDO_SESSAO");
  return createHash("sha256").update(`almox|${cfg.secret}|${extra}`).digest();
}
const b64 = (s) => Buffer.from(s).toString("base64url");
const marcaPin = (cfg, pin) => createHmac("sha256", chaveSessao(cfg)).update(`pin|${pin}`).digest("hex").slice(0, 12);

function assinar(cfg, payload) {
  const corpo = b64(JSON.stringify(payload));
  const sig = createHmac("sha256", chaveSessao(cfg)).update(corpo).digest("base64url");
  return `${corpo}.${sig}`;
}

export function verificarToken(cfg, token) {
  const [corpo, sig] = String(token || "").split(".");
  if (!corpo || !sig) return null;
  const esperado = createHmac("sha256", chaveSessao(cfg)).update(corpo).digest();
  const recebido = Buffer.from(sig, "base64url");
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(corpo, "base64url").toString()); } catch { return null; }
  if (!p.e || Date.now() > p.e) return null;
  // Operador removido ou PIN trocado: a sessão deixa de valer.
  const op = cfg.operadores.get(normalizar(p.n));
  if (!op || marcaPin(cfg, op.pin) !== p.p) return null;
  return { nome: op.nome };
}

export async function login(cfg, nome, pin) {
  if (!cfg.operadores.size) throw new ErroApp("Nenhum operador cadastrado (variável OPERADORES no Netlify).", 500);
  const chave = normalizar(nome);
  if (!chave || !pin) throw new ErroApp("Informe nome e PIN.");
  const s = loja();
  const kTent = `tentativas/${b64(chave)}`;
  const tent = (await s.get(kTent, { type: "json" })) || { n: 0, desde: Date.now() };
  if (Date.now() - tent.desde > 15 * 60_000) { tent.n = 0; tent.desde = Date.now(); }
  if (tent.n >= 5) {
    const min = Math.ceil((tent.desde + 15 * 60_000 - Date.now()) / 60_000);
    throw new ErroApp(`Muitas tentativas erradas. Tente de novo em ${min} min.`, 429);
  }
  const op = cfg.operadores.get(chave);
  const ok = op && op.pin.length === String(pin).length &&
    timingSafeEqual(Buffer.from(op.pin), Buffer.from(String(pin)));
  if (!ok) {
    tent.n += 1;
    await s.setJSON(kTent, tent);
    await new Promise((r) => setTimeout(r, 600));
    throw new ErroApp("Nome ou PIN incorreto.", 401);
  }
  if (tent.n) await s.delete(kTent);
  const dias = 30;
  return {
    token: assinar(cfg, { n: op.nome, p: marcaPin(cfg, op.pin), e: Date.now() + dias * 86_400_000 }),
    nome: op.nome,
  };
}

// ------------------------------------------------------------------ lançamentos

async function registrar(linha) {
  const t = agoraBR();
  const chave = `mov/${t.mes}/${t.ordem}-${randomBytes(3).toString("hex")}`;
  await loja().setJSON(chave, { data_hora: t.texto, ...linha });
}

export async function movimentar(cfg, operador, dados) {
  const tipo = dados.tipo;
  if (!["Entrada", "Saida", "Contagem"].includes(tipo)) throw new ErroApp("Tipo de lançamento inválido");
  const qtde = num(dados.quantidade);
  if (qtde < 0 || (tipo !== "Contagem" && qtde <= 0)) throw new ErroApp("Quantidade inválida");
  if (qtde > 1_000_000) throw new ErroApp("Quantidade muito alta. Confira o valor.");

  const p = await produtoAtual(cfg, dados.id);
  const cod = p.cod_produto || "";
  if (!liberado(cfg, cod)) {
    throw new ErroApp(`Modo teste: o item ${cod} não está liberado para lançamento. ` +
      "Inclua o código em ITENS_LIBERADOS nas variáveis do Netlify.", 409);
  }
  const antes = num(p.estoque_produto);
  const base = { operador, tipo, cod_produto: cod, desc_produto: p.desc_produto, saldo_antes: antes };

  let tipoV, qtdV, obs;
  if (tipo === "Contagem") {
    const diff = Math.round((qtde - antes) * 1e6) / 1e6;
    if (Math.abs(diff) < 1e-9) {
      await registrar({ ...base, quantidade: 0, saldo_depois: antes, obs: "contagem conferiu", resultado: "ok" });
      return { ok: true, msg: "Contagem confere com o vhsys. Nada a ajustar.", produto: publico(cfg, p) };
    }
    tipoV = diff > 0 ? "Entrada" : "Saida";
    qtdV = Math.abs(diff);
    obs = `Inventário app - contado ${br(qtde)}, sistema ${br(antes)} - ${operador}`;
  } else {
    tipoV = tipo; qtdV = qtde;
    if (tipo === "Saida" && qtde > antes + 1e-9 && !dados.forcar) {
      return { ok: false, confirmar: true, msg: `Saldo no vhsys é ${br(antes)}. Lançar saída de ${br(qtde)} mesmo assim?` };
    }
    obs = `Almox app - ${operador}`;
  }
  const extra = String(dados.obs || "").trim().slice(0, 120);
  if (extra) obs += ` - ${extra}`;

  const corpo = {
    tipo_estoque: tipoV,
    qtde_estoque: qtdV.toFixed(4),
    valor_estoque: num(p.valor_custo_produto).toFixed(2),
    obs_estoque: obs.slice(0, 250),
    identificacao: "Almox app",
  };
  const linha = { ...base, tipo: tipo === "Contagem" ? "Contagem" : tipoV,
    quantidade: tipoV === "Entrada" ? qtdV : -qtdV, obs };
  let r;
  try {
    r = await vhsys(cfg, "POST", `/produtos/${p.id_produto}/estoque`, corpo);
  } catch (e) {
    await registrar({ ...linha, saldo_depois: "", resultado: `ERRO: ${e.message}` });
    throw e;
  }
  let depoisP;
  try { depoisP = await produtoAtual(cfg, p.id_produto); }
  catch { depoisP = { ...p, estoque_produto: antes + linha.quantidade }; }
  const depois = num(depoisP.estoque_produto);
  await registrar({ ...linha, saldo_depois: depois, resultado: "ok",
    id_estoque_vhsys: (r.data && r.data.id_estoque) || "" });
  const nome = tipo === "Contagem" ? "Ajuste de inventário lançado" : (tipoV === "Entrada" ? "Entrada lançada" : "Saída lançada");
  return { ok: true, msg: `${nome}: ${tipoV === "Entrada" ? "+" : "−"}${br(qtdV)}. Saldo agora: ${br(depois)}`,
    produto: publico(cfg, depoisP) };
}

async function lerChaves(chaves) {
  const s = loja(), out = [];
  for (let i = 0; i < chaves.length; i += 40) {
    const parte = await Promise.all(chaves.slice(i, i + 40).map((k) => s.get(k, { type: "json" })));
    out.push(...parte.filter(Boolean));
  }
  return out;
}

async function chavesDoMes(mes) {
  const { blobs } = await loja().list({ prefix: `mov/${mes}/` });
  return blobs.map((b) => b.key).sort();
}

export async function ultimos(n = 15) {
  const t = agoraBR();
  let chaves = await chavesDoMes(t.mes);
  if (chaves.length < n) {
    const [a, m] = t.mes.split("-").map(Number);
    const ant = m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
    chaves = (await chavesDoMes(ant)).concat(chaves);
  }
  return (await lerChaves(chaves.slice(-n))).reverse();
}

export async function csvDoMes(mes) {
  if (!/^\d{4}-\d{2}$/.test(mes)) throw new ErroApp("Mês inválido (use AAAA-MM)");
  const linhas = await lerChaves(await chavesDoMes(mes));
  const cols = ["data_hora", "operador", "tipo", "cod_produto", "desc_produto", "quantidade",
    "saldo_antes", "saldo_depois", "obs", "resultado", "id_estoque_vhsys"];
  const cel = (v) => {
    const s = typeof v === "number" ? br(v).replace(/\./g, "") : String(v ?? "");
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [cols.join(";"), ...linhas.map((l) => cols.map((c) => cel(l[c])).join(";"))].join("\r\n");
}
