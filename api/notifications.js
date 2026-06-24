import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Récupérer les notifications et messages
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const sql = neon(process.env.DATABASE_URL);

      const notifications = await sql`
        SELECT * FROM notifications ORDER BY created_at DESC LIMIT 20
      `;
      const messages = await sql`
        SELECT * FROM admin_messages
        WHERE to_email = ${decoded.email}
        ORDER BY created_at DESC
      `;

      res.json({ notifications, messages });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }

  } else if (req.method === 'POST') {
    // Marquer un message comme lu
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Non authentifié' });

    try {
      jwt.verify(token, process.env.JWT_SECRET);
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'ID requis' });

      const sql = neon(process.env.DATABASE_URL);
      await sql`UPDATE admin_messages SET read = TRUE WHERE id = ${id}`;

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }

  } else {
    res.status(405).json({ error: 'Méthode non autorisée' });
  }
}
