// replyDetector · liga-se à inbox por IMAP, deteta respostas de leads,
// marca "respondeu" no Firestore e gera um rascunho de resposta com a IA.
//
// NOTA (Gmail + Cloudflare Email Routing):
// O hello@tech-ramen.com reencaminha para o Gmail. A INBOX tem emails de
// leads misturados com email pessoal. Estratégia robusta:
//   - Olha mensagens recentes (lidas OU não), dos últimos N dias
//   - Associa ao lead por email do remetente OU do reply-to/return-path
//     (o Cloudflare às vezes reescreve o From ao reencaminhar)
//   - Guarda os UIDs já processados para não repetir nem re-notificar
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { admin, getActiveProjects, claude } from './firebase.js';

const DIAS_A_OLHAR = 3;

// Extrai TODOS os emails de um texto (from pode ter vários formatos)
function extractEmails(...partes) {
  const txt = partes.filter(Boolean).join(' ');
  const todos = txt.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return [...new Set(todos.map((e) => e.toLowerCase()))];
}

async function gerarRascunho(project, lead, textoResposta) {
  const prompt = `És ${project.remetente?.nome}, criador do produto "${project.nome}" (${project.produto}, ${project.pricing}).
Um potencial cliente respondeu ao teu email de prospeção. Escreve um rascunho de resposta em PT-PT.

CLIENTE: ${lead.nome}
RESPOSTA DELE: """${textoResposta.slice(0, 1500)}"""

Regras: máx 100 palavras, tom ${project.tom}, objetivo é agendar uma demo de 15 minutos por videochamada
(sugere 2 janelas horárias genéricas), responde às dúvidas dele se as houver.
Responde APENAS com o corpo do email, sem assunto, sem JSON.`;
  return claude(prompt, 500);
}

export async function checkReplies(db) {
  if (!process.env.IMAP_PASSWORD) {
    console.log('[replyDetector] IMAP_PASSWORD não definida — a saltar');
    return;
  }

  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
    logger: false,
    // Timeouts explícitos: sem isto, uma ligação recusada fica pendurada
    // para sempre e congela o worker todo.
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    const desde = new Date(Date.now() - DIAS_A_OLHAR * 86400000);
    // Mensagens recentes, lidas OU não (abrir o email no Gmail não deve escondê-lo)
    const uids = await client.search({ since: desde });
    if (!uids.length) return;

    const projects = await getActiveProjects(db);

    // Carrega os leads com email de todos os projetos ativos, uma vez
    const leadsPorEmail = new Map();
    for (const project of projects) {
      const snap = await db.collection('projects').doc(project.id).collection('leads').get();
      snap.docs.forEach((d) => {
        const lead = { id: d.id, ref: d.ref, project, ...d.data() };
        if (lead.email) leadsPorEmail.set(lead.email.toLowerCase(), lead);
      });
    }

    // Estado: UIDs já processados (para não repetir)
    const stateRef = db.collection('worker_state').doc('replyDetector');
    const state = (await stateRef.get()).data() || {};
    const processados = new Set(state.uidsProcessados || []);

    let novos = 0;

    for (const uid of uids) {
      if (processados.has(uid)) continue;

      const msg = await client.fetchOne(uid, { source: true });
      const parsed = await simpleParser(msg.source);

      // Emails candidatos: do From, Reply-To, e Return-Path
      const candidatos = extractEmails(
        parsed.from?.text,
        parsed.replyTo?.text,
        parsed.headers?.get('return-path'),
      );

      // Ignora emails enviados por nós próprios (o remetente da campanha)
      const meusEmails = projects.map((p) => (p.remetente?.email || '').toLowerCase());

      let lead = null;
      for (const email of candidatos) {
        if (meusEmails.includes(email)) continue;
        if (leadsPorEmail.has(email)) { lead = leadsPorEmail.get(email); break; }
      }

      // Marca como processado independentemente (evita re-análise)
      processados.add(uid);

      if (!lead) continue; // não é resposta de nenhum lead conhecido

      if (['trial', 'cliente', 'opt_out'].includes(lead.estado)) continue;

      const texto = (parsed.text || parsed.subject || '').trim();
      const rascunho = await gerarRascunho(lead.project, lead, texto);

      await lead.ref.update({
        estado: 'respondeu',
        ultimaResposta: texto.slice(0, 2000),
        rascunhoResposta: rascunho,
        respondeuEm: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`[replyDetector] 🔥 ${lead.nome} respondeu (${lead.project.nome})`);
      novos++;
    }

    // Guarda os últimos 500 UIDs processados (evita crescer sem limite)
    await stateRef.set({
      uidsProcessados: [...processados].slice(-500),
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (novos) console.log(`[replyDetector] ${novos} respostas novas`);
  } finally {
    lock.release();
    await client.logout();
  }
}
