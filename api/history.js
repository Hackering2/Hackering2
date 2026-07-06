import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Connexion requise' });

  let user;
  try { user = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Session expirée' }); }

  const sql = neon(process.env.DATABASE_URL);

  // ── RENOMMAGE D'UNE CONVERSATION ──
  if (req.method === 'PATCH') {
    try {
      const { id, title } = req.body || {};
      if (!id || !title?.trim()) {
        return res.status(400).json({ error: 'id et title requis' });
      }

      // Sécurité : on vérifie que cette conversation appartient bien à l'utilisateur connecté
      const owned = await sql`
        SELECT 1 FROM messages WHERE conversation_id = ${id} AND user_email = ${user.email} LIMIT 1
      `;
      if (owned.length === 0) {
        return res.status(404).json({ error: 'Conversation introuvable' });
      }

      await sql`
        CREATE TABLE IF NOT EXISTS conversation_meta (
          conversation_id TEXT PRIMARY KEY,
          user_email TEXT NOT NULL,
          title TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;

      const cleanTitle = title.trim().slice(0, 60);
      await sql`
        INSERT INTO conversation_meta (conversation_id, user_email, title)
        VALUES (${id}, ${user.email}, ${cleanTitle})
        ON CONFLICT (conversation_id) DO UPDATE SET title = ${cleanTitle}, updated_at = NOW()
      `;

      return res.json({ success: true, title: cleanTitle });
    } catch (err) {
      return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
    }
  }

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

    // Titres personnalisés (renommés manuellement) — la table peut ne pas exister encore
    let metaMap = {};
    try {
      const metaRows = await sql`
        SELECT conversation_id, title FROM conversation_meta WHERE user_email = ${user.email}
      `;
      metaMap = Object.fromEntries(metaRows.map(m => [m.conversation_id, m.title]));
    } catch (e) { /* table pas encore créée : pas de titres personnalisés, on ignore */ }

    // Grouper par conversation_id
    const grouped = {};
    for (const msg of messages) {
      const cid = msg.conversation_id || 'default';
      if (!grouped[cid]) {
        grouped[cid] = {
          id: cid,
          date: msg.created_at,
          title: metaMap[cid] || (msg.question.substring(0, 60) + (msg.question.length > 60 ? '...' : '')),
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
