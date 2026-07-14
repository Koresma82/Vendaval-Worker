// socialPublisher · a cada 10 min publica posts com estado 'aprovado'.
// Instagram: renderiza card 1080x1080 (sharp/SVG, cores TechRamen),
//   sobe para o Firebase Storage (URL público) e publica via Graph API.
// LinkedIn: publica texto na página de empresa via API.
// Se as credenciais de uma plataforma faltarem, marca 'pronto_manual'
// (copias da app e publicas com 1 clique — melhor que falhar em silêncio).
import sharp from 'sharp';
import { admin, getActiveProjects } from './firebase.js';

// --- Card visual 1080x1080 com identidade TechRamen -------------
function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrapText(texto, maxChars = 22) {
  const palavras = texto.split(' ');
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    if ((atual + ' ' + p).trim().length > maxChars) {
      linhas.push(atual.trim());
      atual = p;
    } else atual += ' ' + p;
  }
  if (atual.trim()) linhas.push(atual.trim());
  return linhas.slice(0, 4);
}

async function renderCard(titulo, nomeProjeto) {
  const linhas = wrapText(titulo);
  const startY = 540 - (linhas.length - 1) * 48;
  const textoSvg = linhas
    .map((l, i) => `<text x="90" y="${startY + i * 96}" font-family="Arial, sans-serif" font-size="72" font-weight="700" fill="#E8ECF4">${escapeXml(l)}</text>`)
    .join('');

  const svg = `<svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
    <rect width="1080" height="1080" fill="#0E1420"/>
    <rect x="0" y="0" width="1080" height="12" fill="#F5A524"/>
    <text x="90" y="180" font-family="Arial" font-size="34" font-weight="600" fill="#F5A524" letter-spacing="4">${escapeXml(nomeProjeto.toUpperCase())} · TECHRAMEN</text>
    ${textoSvg}
    <text x="90" y="980" font-family="Arial" font-size="30" fill="#8B93A7">tech-ramen.com</text>
    <circle cx="960" cy="950" r="56" fill="none" stroke="#F5A524" stroke-width="6"/>
    <text x="960" y="972" font-family="Arial" font-size="56" text-anchor="middle" fill="#F5A524">🍜</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function uploadImagem(buffer, path) {
  const bucket = admin.storage().bucket();
  const file = bucket.file(path);
  await file.save(buffer, { contentType: 'image/png' });
  await file.makePublic();
  return `https://storage.googleapis.com/${bucket.name}/${path}`;
}

// --- Instagram Graph API ----------------------------------------
async function publicarInstagram(imageUrl, caption) {
  const token = process.env.META_ACCESS_TOKEN;
  const igUser = process.env.IG_USER_ID;
  if (!token || !igUser) return false;

  const r1 = await fetch(`https://graph.facebook.com/v20.0/${igUser}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: token }),
  });
  const { id: creationId } = await r1.json();
  if (!creationId) throw new Error('IG: falha ao criar media container');

  const r2 = await fetch(`https://graph.facebook.com/v20.0/${igUser}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: token }),
  });
  if (!r2.ok) throw new Error('IG: falha ao publicar');
  return true;
}

// --- LinkedIn (página de empresa) --------------------------------
async function publicarLinkedin(texto) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const org = process.env.LINKEDIN_ORG_ID;
  if (!token || !org) return false;

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      author: `urn:li:organization:${org}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: texto },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    }),
  });
  if (!res.ok) throw new Error(`LinkedIn ${res.status}: ${await res.text()}`);
  return true;
}

// --- Loop principal ----------------------------------------------
export async function publishApprovedPosts(db) {
  const projects = await getActiveProjects(db);

  for (const project of projects) {
    const snap = await db
      .collection('projects').doc(project.id).collection('social')
      .where('estado', '==', 'aprovado').limit(20).get();

    const agora = admin.firestore.Timestamp.now();

    for (const docSnap of snap.docs) {
      const post = docSnap.data();
      const updates = {};

      // Só publica quando a data agendada já chegou. Posts aprovados mas
      // ainda no futuro esperam pela sua vez.
      if (post.agendadoPara && post.agendadoPara.toMillis() > agora.toMillis()) {
        continue;
      }

      try {
        // Instagram
        if (!post.publicadoInstagram) {
          let url = post.imagemPropriaUrl;
          // Se não forneceste screenshot, gera o card de texto TechRamen
          if (!url) {
            const buffer = await renderCard(post.tituloImagem || post.tema, project.nome);
            url = await uploadImagem(buffer, `social/${project.id}/${docSnap.id}.png`);
          }
          updates.imagemUrl = url;
          const ok = await publicarInstagram(url, post.instagram);
          updates.publicadoInstagram = ok;
          if (!ok) updates.instagramManual = true; // sem credenciais → manual
        }
        // LinkedIn
        if (!post.publicadoLinkedin) {
          const ok = await publicarLinkedin(post.linkedin);
          updates.publicadoLinkedin = ok;
          if (!ok) updates.linkedinManual = true;
        }

        const tudoAuto = updates.publicadoInstagram !== false && updates.publicadoLinkedin !== false;
        updates.estado = tudoAuto && !updates.instagramManual && !updates.linkedinManual
          ? 'publicado'
          : 'pronto_manual';
        updates.publicadoEm = admin.firestore.FieldValue.serverTimestamp();

        await docSnap.ref.update(updates);
        console.log(`[socialPublisher] post ${docSnap.id} → ${updates.estado}`);
      } catch (err) {
        console.error(`[socialPublisher] ${docSnap.id}:`, err.message);
        await docSnap.ref.update({ estado: 'erro', erro: err.message });
      }
    }
  }
}
