# VENDAVAL WORKER · Railway (24/7)

Worker Node.js sempre ligado (mesmo padrão do bot TradeAI), a falar com o
mesmo Firestore da app Vendaval.

## Loops
- **replyDetector** (60s): IMAP na inbox Gmail (hello@tech-ramen.com reencaminha para la) → deteta respostas de
  leads → marca "Respondeu 🔥" → gera rascunho de resposta com Claude.
  Só marca como lidas as mensagens de leads; o resto da inbox fica intacto.
- **socialGenerator** (semanal): gera 3 posts/projeto (IG + LinkedIn) →
  fila de aprovação na tab "Social" da app.
- **socialPublisher** (10 min): publica posts aprovados. Sem credenciais
  Meta/LinkedIn → marca "Publicar à mão" (copiar da app com 1 clique).

## Deploy no Railway
1. Repo GitHub → New Service no Railway
2. Env vars via **Raw Editor**, com o service account em **BASE64**
   (uma linha — evita o problema do JSON partido que tiveste no TradeAI)
3. Start command: `npm start` (detetado automaticamente)
4. Logs esperados: `🌪 Vendaval Worker iniciado` + 💓 a cada 30 min

## Notas
- `sharp` compila nativamente no Railway (nixpacks) sem config extra.
- IMAP_PASSWORD tem de ser uma App Password do Google (16 chars), nao a password normal.
- Token Meta de longa duracao expira a ~60 dias — renovar no painel Meta.
- Firebase Storage precisa do plano Blaze para URLs públicos (custo: cêntimos).
