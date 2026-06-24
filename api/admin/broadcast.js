import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ error: 'Accès refusé' });

    const { type, title, body } = req.body;
    if (!body) return res.status(400).json({ error: 'Message requis' });

    const sql = neon(process.env.DATABASE_URL);
    await sql`
      INSERT INTO notifications (type, title, body, created_by)
      VALUES (${type || 'info'}, ${title || 'Information'}, ${body}, ${decoded.email})
    `;

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
