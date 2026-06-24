import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Connexion requise' });

  let user;
  try { user = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Session expirée' }); }

  const sql = neon(process.env.DATABASE_URL);

  // GET — récupérer les notifications et messages directs
  if (req.method === 'GET') {
    try {
      const notifications = await sql`
        SELECT id, type, title, body, created_at, created_by
        FROM notifications
        ORDER BY created_at DESC
        LIMIT 20
      `;

      const messages = await sql`
        SELECT id, subject, body, read, created_at
        FROM admin_messages
        WHERE to_email = ${user.email}
        ORDER BY created_at DESC
      `;

      const unreadCount = messages.filter(m => !m.read).length;

      return res.json({ notifications, messages, unreadCount });
    } catch (err) {
      return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
    }

  // POST — marquer un message direct comme lu
  } else if (req.method === 'POST') {
    try {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'ID requis' });

      await sql`
        UPDATE admin_messages
        SET read = TRUE
        WHERE id = ${id} AND to_email = ${user.email}
      `;

      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
    }

  } else {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
}
