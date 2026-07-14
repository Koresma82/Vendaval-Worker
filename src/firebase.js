// Firebase Admin · service account em BASE64 (evita JSON partido no Raw Editor)
import admin from 'firebase-admin';

export function initFirebase() {
  const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(json)),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
  return admin.firestore();
}

export { admin };

export async function getActiveProjects(db) {
  const snap = await db.collection('projects').where('ativo', '==', true).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function claude(prompt, maxTokens = 1500) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const detalhe = await res.text();
    throw new Error(`Claude API ${res.status}: ${detalhe.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
}
