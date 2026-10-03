// aviso_queda.mjs — a chave de emergência e o aviso de queda assinado (SERVIDOR_FORA_DO_AR.md §2).
//
// ⚠️ NADA DISTO ESTÁ PUBLICADO. É a peça da F6 preparada antes, em 13/09/2026: o repositório de
// status (`rogeriofleming/daedalus-status`), o segredo no GitHub e a chave pública dentro do app
// só existem quando o servidor da licença for ao ar.
//
// Uso:
//   node aviso_queda.mjs gerar-chave                     # imprime {privada (JWK), publica} — guardar a privada fora do git
//   node aviso_queda.mjs emitir <queda_desde_iso> [horas] # lê a privada de DAEDALUS_EMERGENCIA_JWK; imprime o aviso
//   node aviso_queda.mjs conferir <arquivo> <publica>     # confere um aviso contra a pública
//
// O formato é o do passe: `DAEQ1.<json em base64url>.<assinatura Ed25519 em base64url>`, assinado
// sobre `DAEQ1.<json em base64url>`. O app recusa aviso que estica mais de 7 dias a partir da queda.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIXO = 'DAEQ1';
const TETO_MS = 7 * 86400000;
const b64u = (b) => Buffer.from(b).toString('base64url');

export async function gerarChave() {
  const par = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    privada: JSON.stringify(await crypto.subtle.exportKey('jwk', par.privateKey)),
    publica: b64u(await crypto.subtle.exportKey('raw', par.publicKey)),
  };
}

// Emite (ou renova) o aviso. `estende_ate` nunca passa de queda_desde + 7 dias — o app recusaria.
export async function emitirAviso({ privadaJwk, quedaDesdeMs, agoraMs = Date.now(), horas = 72, motivo = 'servidor da licença fora do ar' }) {
  if (!Number.isFinite(quedaDesdeMs) || quedaDesdeMs > agoraMs) throw new Error('queda_desde inválida');
  const estende = Math.min(agoraMs + horas * 3600000, quedaDesdeMs + TETO_MS);
  const dados = { v: 1, queda_desde: quedaDesdeMs, estende_ate: estende, emitido: agoraMs, motivo: String(motivo).slice(0, 200) };
  const corpo = b64u(JSON.stringify(dados));
  const chave = await crypto.subtle.importKey('jwk', JSON.parse(privadaJwk), { name: 'Ed25519' }, false, ['sign']);
  const assinatura = await crypto.subtle.sign({ name: 'Ed25519' }, chave, Buffer.from(`${PREFIXO}.${corpo}`));
  return { texto: `${PREFIXO}.${corpo}.${b64u(assinatura)}`, dados };
}

export async function conferirAviso(texto, publicaB64u) {
  const partes = String(texto).trim().split('.');
  if (partes.length !== 3 || partes[0] !== PREFIXO) return null;
  const chave = await crypto.subtle.importKey('raw', Buffer.from(publicaB64u, 'base64url'), { name: 'Ed25519' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, chave, Buffer.from(partes[2], 'base64url'), Buffer.from(`${partes[0]}.${partes[1]}`));
  return ok ? JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8')) : null;
}

const [, , comando, a1, a2] = process.argv;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (comando === 'gerar-chave') {
    console.log(JSON.stringify(await gerarChave(), null, 2));
  } else if (comando === 'emitir') {
    const privadaJwk = process.env.DAEDALUS_EMERGENCIA_JWK;
    if (!privadaJwk) { console.error('falta DAEDALUS_EMERGENCIA_JWK'); process.exit(2); }
    const r = await emitirAviso({ privadaJwk, quedaDesdeMs: Date.parse(a1), horas: Number(a2) || 72 });
    console.log(r.texto);
  } else if (comando === 'conferir') {
    console.log(JSON.stringify(await conferirAviso(readFileSync(a1, 'utf8'), a2)));
  } else if (comando) {
    console.error(`comando desconhecido: ${comando}`);
    process.exit(2);
  }
}
