// socialGenerator · modelo de FILA (depósito de conteúdo).
// Já não gera por mês com datas fixas. Em vez disso:
//   - Mantém uma FILA de posts por projeto.
//   - Quando a fila (pendentes + aprovados por publicar) desce abaixo de
//     um limiar, gera um lote novo (LOTE_TAMANHO posts).
//   - Os posts novos entram como 'pendente' (à espera de aprovação), a menos
//     que o projeto tenha publicacaoAutomatica → entram 'aprovado'.
//   - NÃO têm data: o socialPublisher tira da fila ao ritmo definido
//     (postsPorSemana / dias / hora) e publica aleatoriamente.
import { admin, getActiveProjects, claude } from './firebase.js';

const LOTE_TAMANHO = 40;   // quantos posts gerar de cada vez que a fila esvazia
const LIMIAR_FILA = 5;     // gera mais quando restam menos de isto por publicar

export async function generateSocialContent(db) {
  const projects = await getActiveProjects(db);
  const forcarRef = db.collection('worker_state').doc('socialGenerator');
  const forcarState = (await forcarRef.get()).data() || {};

  for (const project of projects) {
    const col = db.collection('projects').doc(project.id).collection('social');

    // Conta a fila: posts ainda não publicados (pendente ou aprovado)
    const filaSnap = await col
      .where('estado', 'in', ['pendente', 'aprovado'])
      .get();
    const naFila = filaSnap.size;

    // Gera se: a fila está abaixo do limiar, OU o utilizador forçou na app
    const forcarEste = forcarState.forcar === true;
    if (naFila >= LIMIAR_FILA && !forcarEste) continue;

    const jaAprovadoAuto = project.publicacaoAutomatica === true;

    const prompt = `És o gestor de redes sociais da TechRamen (marca indie de software PT, tom autêntico de criador solo).
Gera ${LOTE_TAMANHO} posts variados sobre este produto, para uma fila de publicação:

PRODUTO: ${project.nome} — ${project.produto}
PÚBLICO: ${project.nicho}
ARGUMENTOS: ${(project.valueProps || []).join(' | ')}
LANDING: ${project.landingUrl}

Regras:
- PT-PT sempre. Zero hype vazio.
- IDENTIFICA SEMPRE O PRODUTO: cada post tem de deixar claro que fala do
  "${project.nome}". Menciona o nome no texto e usa a hashtag #${project.nome.replace(/\s/g, '')}.
  O Instagram é partilhado por vários produtos TechRamen — o leitor tem de
  perceber logo que este post é do ${project.nome} (${project.nicho}), não de outro.
- VARIA muito os formatos ao longo dos ${LOTE_TAMANHO}: dicas úteis, bastidores,
  benefícios com CTA suave, perguntas, mitos, casos de uso, comparações.
  Como vão sair baralhados, cada post tem de funcionar sozinho.
- Cada post: "instagram" (curto, 5-8 hashtags incluindo #${project.nome.replace(/\s/g, '')} e as do nicho) e "linkedin" (profissional).
- "tituloImagem": 4-8 palavras para o card visual.
Responde APENAS com JSON válido, sem markdown:
{"posts":[{"tema":"...","instagram":"...","linkedin":"...","tituloImagem":"..."}]}`;

    try {
      // Gera em lotes de 8 para não estourar tokens (40 de uma vez cortaria)
      const SUBLOTE = 8;
      const nSublotes = Math.ceil(LOTE_TAMANHO / SUBLOTE);
      let posts = [];

      for (let i = 0; i < nSublotes; i++) {
        const p = prompt.replace(
          `Gera ${LOTE_TAMANHO} posts`,
          `Gera ${SUBLOTE} posts (parte ${i + 1} de ${nSublotes}, diferentes das outras partes)`,
        );
        const raw = await claude(p, 3500);
        let jsonStr = raw;
        if (!jsonStr.startsWith('{')) {
          const a = jsonStr.indexOf('{'); const b = jsonStr.lastIndexOf('}');
          if (a !== -1 && b !== -1) jsonStr = jsonStr.slice(a, b + 1);
        }
        posts = posts.concat(JSON.parse(jsonStr).posts || []);
      }

      // Grava a fila em lotes de 400 (limite do batch do Firestore é 500)
      let escritos = 0;
      while (escritos < posts.length) {
        const batch = db.batch();
        const fatia = posts.slice(escritos, escritos + 400);
        fatia.forEach((p, idx) => {
          const id = `q_${Date.now()}_${escritos + idx}`;
          batch.set(col.doc(id), {
            ...p,
            estado: jaAprovadoAuto ? 'aprovado' : 'pendente',
            publicadoInstagram: false,
            publicadoLinkedin: false,
            imagemPropriaUrl: null,
            // ordem aleatória: chave usada pelo publisher para baralhar
            ordemAleatoria: Math.random(),
            naFila: true,
            criadoEm: admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        await batch.commit();
        escritos += fatia.length;
      }

      console.log(`[socialGenerator] +${posts.length} posts na fila de ${project.nome} (estava com ${naFila})`);
    } catch (err) {
      console.error(`[socialGenerator] falha em ${project.id}:`, err.message);
    }
  }

  // Limpa a flag de forçar (já gerámos)
  if (forcarState.forcar) {
    await forcarRef.set({ forcar: false, geradoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
}
