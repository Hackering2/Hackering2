import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Connexion requise' });

  let user;
  try { user = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Session expirée' }); }

  if (!user.isAdmin) return res.status(403).json({ error: "Accès réservé à l'administrateur" });

  try {
    const { type, title, body } = req.body;
    if (!body) return res.status(400).json({ error: 'Message requis' });

    const sql = neon(process.env.DATABASE_URL);
    await sql`
      INSERT INTO notifications (type, title, body, created_by)
      VALUES (
        ${type || 'info'},
        ${title || 'Information'},
        ${body},
        ${user.email}
      )
    `;

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
