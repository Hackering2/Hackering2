import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ error: 'Accès refusé' });

    const { email, subject, body } = req.body;
    if (!email || !body) return res.status(400).json({ error: 'Destinataire et message requis' });

    const sql = neon(process.env.DATABASE_URL);
    await sql`
      INSERT INTO admin_messages (to_email, subject, body)
      VALUES (${email}, ${subject || 'Message admin'}, ${body})
    `;

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
