// vigia.mjs — roda no GitHub Actions a cada ~10 min, FORA da Cloudflare (SERVIDOR_FORA_DO_AR.md §2.4).
//
//   1. chama a /api/saude do servidor da licença;
//   2. respondeu → apaga o registro de queda E o aviso, e sai com 0;
//   3. não respondeu → anota desde quando e SAI COM 1 — a tarefa agendada fica vermelha e o GitHub
//      manda e-mail para o dono do repositório (comportamento padrão, sem configurar nada);
//   4. fora há mais de LIMIAR_MS → assina e grava `aviso.txt` (+72 h, teto de 7 dias desde a queda),
//      renovando a cada rodada enquanto a queda durar. Quem faz o commit é o workflow.
//
// Estado no próprio repositório: `estado.json` { queda_desde } e `aviso.txt`.
// Segredo: DAEDALUS_EMERGENCIA_JWK (a chave privada de emergência, só no GitHub Secrets).
// ⚠️ NÃO PUBLICADO — é peça da F6.

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { emitirAviso } from './aviso_queda.mjs';

const SAUDE = process.env.DAEDALUS_SAUDE || 'https://daedalus.rogeriofleming.com.br/api/saude';
// A pública que está EMBUTIDA no app. Servidor respondendo com outra = chave trocada errada: todo
// passe novo seria recusado pelo app — é queda para quem paga, mesmo com a saúde verde (achado M10).
const PUBLICA_DO_APP = process.env.DAEDALUS_CHAVE_PUBLICA_APP || '';
const LIMIAR_MS = Number(process.env.DAEDALUS_LIMIAR_MS || 2 * 3600000);
const PASTA = process.env.DAEDALUS_STATUS_PASTA || '.';
const ESTADO = `${PASTA}/estado.json`;
const AVISO = `${PASTA}/aviso.txt`;

export async function rodada({ agora = Date.now(), buscar = fetch, privadaJwk = process.env.DAEDALUS_EMERGENCIA_JWK } = {}) {
  let noAr = false;
  try {
    const r = await buscar(SAUDE, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    const j = await r.json().catch(() => null);
    noAr = r.ok && j && j.ok === true;
    if (noAr && PUBLICA_DO_APP) {
      const rp = await buscar(SAUDE.replace(/\/api\/saude$/, '/api/chave-publica'), { signal: AbortSignal.timeout(20000), cache: 'no-store' });
      const jp = await rp.json().catch(() => null);
      noAr = rp.ok && jp && jp.chave_publica === PUBLICA_DO_APP;
    }
  } catch (_) { noAr = false; }

  if (noAr) {
    if (existsSync(ESTADO)) rmSync(ESTADO);
    // o aviso sai junto: um aviso velho publicado depois da volta só serve a quem quer burlar
    // (achado G1 — o app também recusa passe emitido depois da queda, as duas travas valem)
    if (existsSync(AVISO)) rmSync(AVISO);
    return { noAr: true, emitiu: false };
  }

  const estado = existsSync(ESTADO) ? JSON.parse(readFileSync(ESTADO, 'utf8')) : {};
  if (!Number.isFinite(estado.queda_desde)) {
    estado.queda_desde = agora;
    writeFileSync(ESTADO, `${JSON.stringify(estado)}\n`);
  }
  if (agora - estado.queda_desde < LIMIAR_MS) return { noAr: false, emitiu: false, quedaDesde: estado.queda_desde };
  if (!privadaJwk) return { noAr: false, emitiu: false, erro: 'sem chave de emergência' };
  const { texto, dados } = await emitirAviso({ privadaJwk, quedaDesdeMs: estado.queda_desde, agoraMs: agora });
  writeFileSync(AVISO, `${texto}\n`);
  return { noAr: false, emitiu: true, ate: dados.estende_ate };
}

if (process.argv[1] && process.argv[1].endsWith('vigia.mjs')) {
  const r = await rodada();
  console.log(JSON.stringify(r));
  process.exit(r.noAr ? 0 : 1);
}
