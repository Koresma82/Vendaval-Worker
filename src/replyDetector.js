// replyDetector · liga-se à inbox por IMAP, deteta respostas de leads,
// marca "respondeu" no Firestore e gera um rascunho de resposta com a IA.
// É este módulo que fecha o ciclo de vendas sem trabalho manual.
//
// NOTA (Gmail + Cloudflare Email Routing):
// O hello@tech-ramen.com reencaminha para o Gmail pessoal, por isso a INBOX
// tem emails de leads MISTURADOS com email pessoal. Duas salvaguardas:
//   1. Só olhamos para mensagens não-lidas dos últimos 7 dias
//   2. Só marcamos como lida a mensagem SE o remetente for um lead conhecido
// O resto da tua inbox fica intacto.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { admin, getActiveProjects, claude } from './firebase.js';

const DIAS_A_OLHAR = 7;

function extractEmail(addr) {
  const m = String(addr || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : '';
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
  if (!process.env.IMAP_PASSWORD) return; // IMAP não configurado

  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    // Só não-lidos dos últimos N dias — protege a inbox pessoal e é mais rápido
    const desde = new Date(Date.now() - DIAS_A_OLHAR * 86400000);
    const unseen = await client.search({ seen: false, since: desde });
    if (!unseen.length) return;

    const projects = await getActiveProjects(db);

    for (const uid of unseen) {
      const msg = await client.fetchOne(uid, { source: true });
      const parsed = await simpleParser(msg.source);
      const remetente = extractEmail(parsed.from?.text);
      if (!remetente) continue;

      // Procurar o remetente nos leads de todos os projetos ativos
      let encontrado = false;
      for (const project of projects) {
        const snap = await db
          .collection('projects').doc(project.id).collection('leads')
          .where('email', '==', remetente).limit(1).get();
        if (snap.empty) continue;

        const leadRef = snap.docs[0].ref;
        const lead = snap.docs[0].data();
        encontrado = true;

        // Não regredir estados avançados
        if (!['trial', 'cliente', 'opt_out'].includes(lead.estado)) {
          const texto = (parsed.text || '').trim();
          const rascunho = await gerarRascunho(project, lead, texto);

          await leadRef.update({
            estado: 'respondeu',
            ultimaResposta: texto.slice(0, 2000),
            rascunhoResposta: rascunho,
            respondeuEm: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`[replyDetector] 🔥 ${lead.nome} respondeu (${project.nome})`);
        }
        break;
      }

      // Marcar como lida apenas se era de um lead (o resto da inbox fica intacto)
      if (encontrado) await client.messageFlagsAdd(uid, ['\\Seen']);
    }
  } finally {
    lock.release();
    await client.logout();
  }
}
