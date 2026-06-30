import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

// Modèle Groq utilisé pour toutes les requêtes.
// llama-3.3-70b-versatile a été déprécié par Groq — remplacé par
// openai/gpt-oss-120b (le plus solide actuellement pour suivre des
// instructions structurées comme la génération de diagrammes HTML).
const GROQ_MODEL = 'openai/gpt-oss-120b';

function getUserFromToken(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Connexion requise.' });

  const { messages, conversationId } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages manquant' });

  // ── DÉTECTION DE DEMANDE DE DIAGRAMME ──
  // Le PROMPT SYSTÈME (avec les instructions complètes de génération de
  // diagrammes au format 'html-diagram' + classes .dg-*) est déjà envoyé
  // par le front-end en premier message du tableau `messages`.
  // On ne le duplique plus ici pour éviter d'envoyer deux prompts système
  // contradictoires à Groq — ce backend se contente de détecter la demande
  // de diagramme pour augmenter le budget de tokens en conséquence.
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
  const isDiagram = /diagramme|schéma|schema|flowchart|procédé|etapes de fabrication|étapes de fabrication|flux de production|processus de fabrication|fabrication de|comment fabriquer|technologie de fabrication|diag\b|flow\b/i.test(
    typeof lastUserMsg === 'string' ? lastUserMsg : lastUserMsg?.[0]?.text || ''
  );

  try {
    // ── ROTATION DES CLÉS API ──
    const sql = neon(process.env.DATABASE_URL);

    // Récupérer toutes les clés actives triées par usage (la moins utilisée en premier)
    let activeKeys = [];
    try {
      const rows = await sql`
        SELECT id, key_value FROM api_keys
        WHERE is_active = true
        ORDER BY usage_count ASC, id ASC
      `;
      activeKeys = rows;
    } catch(e) { console.error('DB apikeys error:', e.message); }

    // Construire le pool : clés DB en premier, clé env en fallback
    const keyPool = [
      ...activeKeys.map(k => ({ id: k.id, key: k.key_value, fromDb: true })),
      { id: null, key: process.env.GROQ_API_KEY, fromDb: false }
    ].filter(k => k.key);

    if (!keyPool.length) return res.status(500).json({ error: 'Aucune clé API disponible.' });

    // Essayer chaque clé jusqu'à succès
    let groqResponse, data, usedKey;
    for (const candidate of keyPool) {
      try {
        groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${candidate.key}` },
          body: JSON.stringify({
            model: GROQ_MODEL,
            max_tokens: isDiagram ? 4000 : 1000,
            temperature: 0.6,
            messages: messages
          })
        });
        data = await groqResponse.json();
        if (groqResponse.ok) { usedKey = candidate; break; }
        // 401 ou 429 → essayer la suivante
        if (groqResponse.status === 401 || groqResponse.status === 429) {
          console.warn(`Clé ${candidate.id || 'env'} indisponible (${groqResponse.status}), rotation…`);
          // Désactiver la clé DB si quota épuisé (429)
          if (candidate.fromDb && groqResponse.status === 429) {
            try { await sql`UPDATE api_keys SET is_active=false WHERE id=${candidate.id}`; } catch(_) {}
          }
          continue;
        }
        // Autre erreur → on arrête
        return res.status(groqResponse.status).json({ error: data.error?.message || 'Erreur Groq' });
      } catch(fetchErr) {
        console.error('Fetch error clé', candidate.id, fetchErr.message);
        continue;
      }
    }

    if (!groqResponse?.ok || !data) {
      return res.status(503).json({ error: 'Toutes les clés API sont épuisées ou invalides. Veuillez en ajouter de nouvelles dans le panneau Admin.' });
    }

    // Incrémenter le compteur d'usage de la clé utilisée
    if (usedKey?.fromDb && usedKey.id) {
      try {
        await sql`UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ${usedKey.id}`;
      } catch(e) { console.error('Usage count error:', e.message); }
    }

    const reply = data.choices?.[0]?.message?.content || '';
    const lastUserMsgText = messages.filter(m => m.role === 'user').pop()?.content || '';
    const convId = conversationId || `${user.email}:${Date.now()}`;

    try {
      await sql`INSERT INTO messages (user_email, question, reponse, conversation_id)
                VALUES (${user.email}, ${lastUserMsgText}, ${reply}, ${convId})`;
    } catch (e) { console.error('DB msg error:', e.message); }

    return res.status(200).json({ ...data, conversationId: convId });
  } catch (err) {
    return res.status(500).json({ error: 'Impossible de joindre Groq : ' + err.message });
  }
}
