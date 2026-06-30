// ── /api/chat.js — Fonction serverless Vercel (Groq) ──
//
// Déploiement :
// 1. Place ce fichier dans /api/chat.js à la racine de ton repo GitHub
// 2. npm install openai   (le SDK OpenAI fonctionne avec Groq via baseURL)
// 3. Sur le dashboard Vercel → Settings → Environment Variables, ajoute :
//      GROQ_API_KEY = gsk_xxxxxxxx
//    (jamais dans le code, jamais commit sur GitHub)
// 4. Push sur GitHub → Vercel redéploie automatiquement
//
// Le modèle le plus qualitatif actuellement chez Groq pour ce type de tâche
// (diagrammes HTML détaillés, suivi de structure complexe) est
// "openai/gpt-oss-120b". Tu peux le changer ci-dessous si tu préfères un
// autre modèle Groq (ex: "qwen/qwen3.6-27b").

const OpenAI = require('openai');

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const MODEL = 'openai/gpt-oss-120b';

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    // TODO : remets ici ta logique d'auth existante (vérif token Bearer)
    // si tu en as une, avant de continuer.

    const { messages, conversationId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Le champ "messages" est requis' });
    }

    // Format déjà compatible OpenAI : pas besoin de séparer le system prompt,
    // Groq accepte { role: 'system', content: ... } directement dans le tableau.
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: messages,
      temperature: 0.6,
      max_tokens: 4096,
    });

    const text = completion.choices[0]?.message?.content || '';

    // ⚠️ Format identique à celui que ton front attend déjà
    // (data.choices[0].message.content) — aucune modif du front nécessaire.
    return res.status(200).json({
      choices: [{ message: { role: 'assistant', content: text } }],
      conversationId: conversationId || null,
    });

  } catch (err) {
    console.error('Erreur Groq API:', err);
    return res.status(500).json({ error: err.message || 'Erreur serveur Groq' });
  }
};
