import { kv } from '@vercel/kv';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

function getUserFromToken(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { messages } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages manquant' });

  // Identifier l'utilisateur si connecté (optionnel, le chat marche aussi sans compte)
  const user = getUserFromToken(req);

  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        messages: messages
      })
    });

    const data = await groqResponse.json();

    if (!groqResponse.ok) {
      return res.status(groqResponse.status).json({ error: data.error?.message || 'Erreur Groq' });
    }

    // Sauvegarder la conversation si l'utilisateur est connecté
    if (user) {
      const reply = data.choices?.[0]?.message?.content || '';
      const lastUserMsg = messages[messages.length - 1]?.content || '';

      const convoKey = `convo:${user.email}`;
      const existing = (await kv.get(convoKey)) || [];
      existing.push({
        timestamp: new Date().toISOString(),
        question: lastUserMsg,
        reponse: reply
      });
      await kv.set(convoKey, existing);

      // Ajouter cet utilisateur à la liste connue (pour que l'admin puisse les lister)
      const allUsers = (await kv.get('users:list')) || [];
      if (!allUsers.includes(user.email)) {
        allUsers.push(user.email);
        await kv.set('users:list', allUsers);
      }
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Impossible de joindre Groq : ' + err.message });
  }
}
