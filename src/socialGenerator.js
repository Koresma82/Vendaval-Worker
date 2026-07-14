// socialGenerator · gera um MÊS de conteúdo de uma vez (12 posts/projeto),
// com datas de publicação agendadas automaticamente (3/semana em horários B2B).
// Os posts ficam 'pendente' à espera de aprovação em lote na app.
// O socialPublisher só publica cada um quando a data agendada chega.
import { admin, getActiveProjects, claude } from './firebase.js';

const POSTS_POR_MES = 12;            // 3/semana x 4 semanas
const HORARIOS = ['09:30', '13:00', '18:30']; // bons horários B2B (PT)
const DIAS_SEMANA = [1, 3, 5];       // seg, qua, sex (1=seg ... 5=sex)

function mesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Calcula 12 datas: seg/qua/sex às HORARIOS, a começar no próximo dia útil.
// Espalha os 3 horários pelos posts para não sair tudo à mesma hora.
function calcularAgenda(n) {
  const datas = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1); // começa amanhã
  let h = 0;
  while (datas.length < n) {
    if (DIAS_SEMANA.includes(d.getDay())) {
      const [hh, mm] = HORARIOS[h % HORARIOS.length].split(':');
      const data = new Date(d);
      data.setHours(Number(hh), Number(mm), 0, 0);
      datas.push(data);
      h++;
    }
    d.setDate(d.getDate() + 1);
  }
  return datas;
}

export async function generateSocialContent(db) {
  const stateRef = db.collection('worker_state').doc('socialGenerator');
  const state = (await stateRef.get()).data() || {};
  const mes = mesAtual();

  // Gera uma vez por mês (automático). O botão "Gerar mês" na app força
  // via campo forcarGeracao — ver App. Aqui respeitamos o ciclo mensal.
  if (state.ultimoMes === mes && !state.forcar) return;

  const projects = await getActiveProjects(db);

  for (const project of projects) {
    const prompt = `És o gestor de redes sociais da TechRamen (marca indie de software, tom autêntico de criador solo português).
Gera ${POSTS_POR_MES} posts para um mês inteiro sobre o produto:

PRODUTO: ${project.nome} — ${project.produto}
PÚBLICO: ${project.nicho}
ARGUMENTOS: ${(project.valueProps || []).join(' | ')}
LANDING: ${project.landingUrl}

Regras:
- PT-PT sempre. Zero hype vazio, zero "🚀 GAME CHANGER".
- Varia os formatos ao longo do mês: dicas úteis para o público (valor real),
  bastidores/build-in-public, benefícios concretos com CTA suave, perguntas
  que geram interação, mitos a desfazer. Não repitas a mesma estrutura.
- Cada post: versão "instagram" (curta, 5-8 hashtags) e versão "linkedin"
  (mais longa, profissional, sem excesso de hashtags).
- "tituloImagem": frase de 4-8 palavras para o card visual.
Responde APENAS com JSON válido, sem markdown:
{"posts":[{"tema":"...","instagram":"...","linkedin":"...","tituloImagem":"..."}]}`;

    try {
      const raw = await claude(prompt, 4000);
      let jsonStr = raw;
      if (!jsonStr.startsWith('{')) {
        const i = jsonStr.indexOf('{'); const j = jsonStr.lastIndexOf('}');
        if (i !== -1 && j !== -1) jsonStr = jsonStr.slice(i, j + 1);
      }
      const { posts } = JSON.parse(jsonStr);
      const agenda = calcularAgenda(posts.length);

      const batch = db.batch();
      const col = db.collection('projects').doc(project.id).collection('social');

      posts.forEach((p, i) => {
        batch.set(col.doc(`${mes}_${i}`), {
          ...p,
          estado: project.publicacaoAutomatica === true ? 'aprovado' : 'pendente',
          publicadoInstagram: false,
          publicadoLinkedin: false,
          // Data agendada: o publisher só publica quando esta data chega
          agendadoPara: admin.firestore.Timestamp.fromDate(agenda[i]),
          // Imagem: null = usa card gerado. Se meteres URL de screenshot, usa essa.
          imagemPropriaUrl: null,
          mes,
          criadoEm: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();
      console.log(`[socialGenerator] ${posts.length} posts (mês) gerados para ${project.nome}`);
    } catch (err) {
      console.error(`[socialGenerator] falha em ${project.id}:`, err.message);
    }
  }

  await stateRef.set({
    ultimoMes: mes,
    forcar: false,
    geradoEm: admin.firestore.FieldValue.serverTimestamp(),
  });
}
