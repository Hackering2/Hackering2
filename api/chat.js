import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

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

  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1000, messages })
    });

    const data = await groqResponse.json();
    if (!groqResponse.ok) return res.status(groqResponse.status).json({ error: data.error?.message || 'Erreur Groq' });

    const reply = data.choices?.[0]?.message?.content || '';
    const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
    const convId = conversationId || `${user.email}:${Date.now()}`;

    try {
      const sql = neon(process.env.DATABASE_URL);
      await sql`INSERT INTO messages (user_email, question, reponse, conversation_id)
                VALUES (${user.email}, ${lastUserMsg}, ${reply}, ${convId})`;
    } catch (e) { console.error('DB error:', e.message); }

    return res.status(200).json({ ...data, conversationId: convId });
  } catch (err) {
    return res.status(500).json({ error: 'Impossible de joindre Groq : ' + err.message });
  }
}
