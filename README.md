# daedalus-status

O vigia do servidor da licença do **Daedalus**, e o aviso de queda assinado.

Este repositório existe **fora da Cloudflare** de propósito: se o servidor da licença cair,
é daqui que o app descobre que a queda é real — e não de uma máquina que bloqueou o endereço
para ganhar Pro de graça.

- `vigia.mjs` — roda a cada ~10 min pelo GitHub Actions: pergunta ao servidor se ele consegue
  **emitir passe** (não basta responder "ok") e se a chave pública dele é a mesma embutida no app.
- `aviso_queda.mjs` — assina o aviso com a chave de emergência (Ed25519). Esse aviso só
  **estende passe que já existe**; ele não cria Pro para ninguém e não libera computador derrubado.
- `aviso.txt` — só existe enquanto a queda durar. O app lê este arquivo pelo endereço cru.
- `estado.json` — desde quando o servidor está fora.

Nada aqui é segredo: o aviso vale pela assinatura, não por estar escondido.
