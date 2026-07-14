// ============================================================
// VENDAVAL WORKER · Railway (24/7)
// ------------------------------------------------------------
// Mesmo padrão do bot TradeAI: processo Node.js sempre ligado,
// a falar com o MESMO Firestore da app Netlify.
//
// Loops:
//   1. replyDetector   → IMAP a cada 60s: deteta respostas de leads,
//                        marca "respondeu", gera rascunho de resposta (Claude)
//   2. socialGenerator → 1x/dia: gera posts sociais por projeto (Claude)
//                        e coloca-os na fila de aprovação da app
//   3. socialPublisher → a cada 10 min: publica posts aprovados
//                        (Instagram/LinkedIn se configurados)
// ============================================================
import { initFirebase } from './src/firebase.js';
import { checkReplies } from './src/replyDetector.js';
import { generateSocialContent } from './src/socialGenerator.js';
import { publishApprovedPosts } from './src/socialPublisher.js';

const db = initFirebase();

console.log('🌪  Vendaval Worker iniciado', new Date().toISOString());

// Wrapper: um loop nunca pode matar o processo (lição TradeAI)
async function safe(nome, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[${nome}] erro:`, err.message);
  }
}

// Loop 1 · respostas de email — a cada 60s
setInterval(() => safe('replyDetector', () => checkReplies(db)), 60_000);
safe('replyDetector', () => checkReplies(db));

// Loop 2 · geração de conteúdo social — verifica de hora a hora
// se já correu hoje (guarda estado em worker_state/socialGenerator)
setInterval(() => safe('socialGenerator', () => generateSocialContent(db)), 3_600_000);
safe('socialGenerator', () => generateSocialContent(db));

// Loop 3 · publicação de posts aprovados — a cada 10 min
setInterval(() => safe('socialPublisher', () => publishApprovedPosts(db)), 600_000);
safe('socialPublisher', () => publishApprovedPosts(db));

// Heartbeat para os logs do Railway
setInterval(() => console.log('💓', new Date().toISOString()), 1_800_000);
