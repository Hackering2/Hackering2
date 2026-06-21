import { neon } from '@neondatabase/serverless';
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

      try {
        const sql = neon(process.env.DATABASE_URL);
        await sql`
          INSERT INTO messages (user_email, question, reponse)
          VALUES (${user.email}, ${lastUserMsg}, ${reply})
        `;
      } catch (dbErr) {
        // On ne bloque pas la réponse du chat si la sauvegarde échoue
        console.error('Erreur sauvegarde:', dbErr.message);
      }
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Impossible de joindre Groq : ' + err.message });
  }
}
