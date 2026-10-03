// vigia.mjs — roda no GitHub Actions a cada ~10 min, FORA da Cloudflare (SERVIDOR_FORA_DO_AR.md §2.4).
//
//   1. pergunta ao servidor se ele está no ar (ver `olhar` abaixo — são DOIS endereços);
//   2. está → apaga o registro de queda E o aviso, e sai com 0;
//   3. não está → anota desde quando e SAI COM 1 — a tarefa agendada fica vermelha e o GitHub
//      manda e-mail para o dono do repositório (comportamento padrão, sem configurar nada);
//   4. fora há mais de LIMIAR_MS → assina e grava `aviso.txt` (+72 h, teto de 7 dias desde a queda),
//      renovando a cada rodada enquanto a queda durar. Quem faz o commit é o workflow.
//
// ⚠️ POR QUE SÃO DOIS ENDEREÇOS (03/10/2026) — a coisa que fez este arquivo ficar desarmado:
// a zona `rogeriofleming.com.br` responde `403 cf-mitigated: challenge` a quem vem de datacenter,
// e o runner do GitHub é datacenter. Medido naquele dia, de dentro do runner: 403 na /api/saude,
// na /api/chave-publica, no /baixar e na própria página de venda. Pelo domínio do produto o vigia
// NÃO CONSEGUE distinguir "o servidor caiu" de "o firewall me barrou" — ligado assim, mandaria
// e-mail de queda a cada 10 minutos para sempre e ensinaria o Roger a ignorar o aviso que existe
// justamente para o dia da queda real.
//
// Então:
//   • VEREDITO = o endereço `*.workers.dev` do mesmo Worker. Ele não está na zona, logo não passa
//     pelo Bot Fight Mode dela, e responde só /api/saude e /api/chave-publica (guarda no worker).
//   • O domínio do produto continua sendo olhado, porque é por ele que o APP fala. Mas a leitura
//     dele é interpretada: 403-challenge NÃO é queda (é o firewall); erro de rede, DNS ou 5xx É
//     queda, mesmo com o workers.dev verde — se o domínio morrer, o app de quem pagou trava igual.
//
// Estado no próprio repositório: `estado.json` { queda_desde } e `aviso.txt`.
// Segredo: DAEDALUS_EMERGENCIA_JWK (a chave privada de emergência, só no GitHub Secrets).

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { emitirAviso } from './aviso_queda.mjs';

// o que decide: fora da zona, sem challenge
const VIGIA = process.env.DAEDALUS_SAUDE_VIGIA || 'https://daedalus-licenca.rogeriofleming587.workers.dev';
// o endereço que o APP usa: o que o comprador depende
const PRODUTO = process.env.DAEDALUS_SAUDE_PRODUTO || 'https://daedalus.rogeriofleming.com.br';
// A pública que está EMBUTIDA no app. Servidor respondendo com outra = chave trocada errada: todo
// passe novo seria recusado pelo app — é queda para quem paga, mesmo com a saúde verde (achado M10).
const PUBLICA_DO_APP = process.env.DAEDALUS_CHAVE_PUBLICA_APP || '';
const LIMIAR_MS = Number(process.env.DAEDALUS_LIMIAR_MS || 2 * 3600000);
const PASTA = process.env.DAEDALUS_STATUS_PASTA || '.';
const ESTADO = `${PASTA}/estado.json`;
const AVISO = `${PASTA}/aviso.txt`;

// Uma olhada num endereço. Devolve o que foi visto, SEM julgar — quem julga é `olhar`.
async function espiar(base, buscar) {
  try {
    const r = await buscar(`${base}/api/saude`, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    // `headers?.get?.()` porque nos testes o `buscar` é um dublê simples, sem Headers de verdade —
    // e uma exceção aqui seria lida como "sem resposta", o que é um diagnóstico errado
    const cab = (n) => r.headers?.get?.(n) || '';
    // o desafio do firewall vem como 403 com este cabeçalho, ou como HTML em vez de JSON
    const challenge = r.status === 403 && (cab('cf-mitigated') === 'challenge' || /text\/html/.test(cab('content-type')));
    if (challenge) return { situacao: 'barrado', status: r.status };
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.ok === true) return { situacao: 'no_ar', status: r.status, corpo: j };
    return { situacao: 'doente', status: r.status, corpo: j };
  } catch (e) {
    return { situacao: 'sem_resposta', erro: String(e?.message || e).slice(0, 200) };
  }
}

// A pública que o servidor entrega tem de ser a MESMA que está dentro do app.
async function chaveConfere(base, buscar) {
  if (!PUBLICA_DO_APP) return true;   // sem o valor configurado não há o que comparar
  try {
    const r = await buscar(`${base}/api/chave-publica`, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    const j = await r.json().catch(() => null);
    return !!(r.ok && j && j.chave_publica === PUBLICA_DO_APP);
  } catch (_) { return false; }
}

// O veredito, com o porquê escrito — é o que vai para o log do Actions e para o e-mail.
export async function olhar(buscar = fetch) {
  const v = await espiar(VIGIA, buscar);
  const p = await espiar(PRODUTO, buscar);

  // o endereço do vigia é o que decide se o Worker está vivo
  if (v.situacao !== 'no_ar') {
    return { noAr: false, porque: `o endereco do vigia nao respondeu (${v.situacao}${v.status ? ` ${v.status}` : ''}${v.erro ? `: ${v.erro}` : ''})`, v, p };
  }
  // ...mas o domínio do produto é por onde o app fala. 'barrado' é o firewall, não queda.
  if (p.situacao === 'sem_resposta' || p.situacao === 'doente') {
    return { noAr: false, porque: `o Worker esta vivo, mas o dominio do produto falhou (${p.situacao}${p.status ? ` ${p.status}` : ''}) — o app de quem pagou fala por ele`, v, p };
  }
  if (!(await chaveConfere(VIGIA, buscar))) {
    return { noAr: false, porque: 'a chave publica do servidor nao e a que esta embutida no app: todo passe novo seria recusado', v, p };
  }
  return { noAr: true, porque: p.situacao === 'barrado' ? 'no ar (o dominio do produto respondeu challenge ao runner, o que e esperado e nao e queda)' : 'no ar pelos dois enderecos', v, p };
}

export async function rodada({ agora = Date.now(), buscar = fetch, privadaJwk = process.env.DAEDALUS_EMERGENCIA_JWK } = {}) {
  const veredito = await olhar(buscar);

  if (veredito.noAr) {
    if (existsSync(ESTADO)) rmSync(ESTADO);
    // o aviso sai junto: um aviso velho publicado depois da volta só serve a quem quer burlar
    // (achado G1 — o app também recusa passe emitido depois da queda, as duas travas valem)
    if (existsSync(AVISO)) rmSync(AVISO);
    return { noAr: true, emitiu: false, porque: veredito.porque };
  }

  const estado = existsSync(ESTADO) ? JSON.parse(readFileSync(ESTADO, 'utf8')) : {};
  if (!Number.isFinite(estado.queda_desde)) {
    estado.queda_desde = agora;
    writeFileSync(ESTADO, `${JSON.stringify(estado)}\n`);
  }
  if (agora - estado.queda_desde < LIMIAR_MS) return { noAr: false, emitiu: false, quedaDesde: estado.queda_desde, porque: veredito.porque };
  if (!privadaJwk) return { noAr: false, emitiu: false, erro: 'sem chave de emergência', porque: veredito.porque };
  const { texto, dados } = await emitirAviso({ privadaJwk, quedaDesdeMs: estado.queda_desde, agoraMs: agora });
  writeFileSync(AVISO, `${texto}\n`);
  return { noAr: false, emitiu: true, ate: dados.estende_ate, porque: veredito.porque };
}

if (process.argv[1] && process.argv[1].endsWith('vigia.mjs')) {
  const r = await rodada();
  console.log(JSON.stringify(r));
  process.exit(r.noAr ? 0 : 1);
}
