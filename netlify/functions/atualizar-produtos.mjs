// Atualiza a lista de produtos do vhsys 3 vezes por dia (6h, 12h e 18h de Brasília).
import { config as lerConfig, baixarProdutos } from "../lib/core.mjs";

export default async () => {
  const n = await baixarProdutos(lerConfig());
  console.log(`[agendado] ${n} produtos atualizados`);
};

export const config = { schedule: "0 9,15,21 * * *" };
