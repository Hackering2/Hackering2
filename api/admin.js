import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Connexion requise' });

  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expirée' });
  }

  if (!user.isAdmin) {
    return res.status(403).json({ error: 'Accès réservé à l\'administrateur' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    const users = await sql`SELECT email, name, is_admin, created_at FROM users ORDER BY created_at DESC`;

    const result = [];
    for (const u of users) {
      const msgs = await sql`
        SELECT question, reponse, created_at FROM messages
        WHERE user_email = ${u.email}
        ORDER BY created_at DESC
        LIMIT 50
      `;
      result.push({
        email: u.email,
        name: u.name,
        isAdmin: u.is_admin,
        createdAt: u.created_at,
        messageCount: msgs.length,
        conversation: msgs.reverse()
      });
    }

    return res.json({ users: result });

  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
