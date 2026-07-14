// ============================================================
// VENDAVAL WORKER · Railway (24/7)
// ============================================================
import { initFirebase } from './src/firebase.js';
import { checkReplies } from './src/replyDetector.js';
import { generateSocialContent } from './src/socialGenerator.js';
import { publishApprovedPosts } from './src/socialPublisher.js';

const db = initFirebase();

console.log('🌪  Vendaval Worker iniciado', new Date().toISOString());

// Corre fn com timeout: se demorar demais (ex.: IMAP pendurado), aborta
// em vez de travar o processo todo. Uma promessa que nunca resolve deixaria
// de outra forma o worker congelado para sempre.
function comTimeout(promise, ms, nome) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${nome}: timeout ${ms}ms`)), ms)),
  ]);
}

async function safe(nome, fn, timeoutMs = 45000) {
  const inicio = Date.now();
  try {
    await comTimeout(fn(), timeoutMs, nome);
    const dur = Date.now() - inicio;
    if (dur > 3000) console.log(`[${nome}] ok (${dur}ms)`);
  } catch (err) {
    console.error(`[${nome}] erro:`, err.message);
  }
}

// Loop 1 · respostas de email — a cada 60s (timeout 45s)
setInterval(() => safe('replyDetector', () => checkReplies(db), 45000), 60_000);
safe('replyDetector', () => checkReplies(db), 45000);

// Loop 2 · geração de conteúdo social — de hora a hora (timeout 5 min, gera muito)
setInterval(() => safe('socialGenerator', () => generateSocialContent(db), 300000), 3_600_000);
safe('socialGenerator', () => generateSocialContent(db), 300000);

// Loop 3 · publicação de posts aprovados — a cada 10 min
setInterval(() => safe('socialPublisher', () => publishApprovedPosts(db), 120000), 600_000);
safe('socialPublisher', () => publishApprovedPosts(db), 120000);

// Heartbeat frequente (a cada 2 min) para veres que o worker está vivo
setInterval(() => console.log('💓', new Date().toISOString()), 120_000);
