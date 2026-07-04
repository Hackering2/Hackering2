import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Connexion requise' });

  let user;
  try { user = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Session expirée' }); }

  const sql = neon(process.env.DATABASE_URL);

  // ── SUPPRESSION DE CONVERSATION(S) ──
  if (req.method === 'DELETE') {
    try {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'Aucune conversation à supprimer (ids manquants)' });
      }

      // Sécurité : on ne supprime que les messages appartenant à l'utilisateur connecté
      const result = await sql`
        DELETE FROM messages
        WHERE user_email = ${user.email} AND conversation_id = ANY(${ids})
        RETURNING conversation_id
      `;

      return res.json({ success: true, deleted: result.length });
    } catch (err) {
      return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
    }
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const messages = await sql`
      SELECT conversation_id, question, reponse, created_at
      FROM messages
      WHERE user_email = ${user.email}
      ORDER BY created_at ASC
    `;

    // Grouper par conversation_id
    const grouped = {};
    for (const msg of messages) {
      const cid = msg.conversation_id || 'default';
      if (!grouped[cid]) {
        grouped[cid] = {
          id: cid,
          date: msg.created_at,
          title: msg.question.substring(0, 60) + (msg.question.length > 60 ? '...' : ''),
          messages: []
        };
      }
      grouped[cid].messages.push({
        question: msg.question,
        reponse: msg.reponse,
        created_at: msg.created_at
      });
    }

    // Trier par date décroissante (plus récent en premier)
    const conversations = Object.values(grouped).sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    return res.json({ conversations });

  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
