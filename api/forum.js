import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

function getUser(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function isAdmin(user) {
  return user && (user.isAdmin === true || user.role === 'admin' || user.email === ADMIN_EMAIL);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Connexion requise' });

  const sql = neon(process.env.DATABASE_URL);

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS forum_posts (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        user_name TEXT,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, user_email, user_name, body, created_at
        FROM forum_posts
        ORDER BY created_at ASC
        LIMIT 300
      `;
      return res.json({ posts: rows });
    }

    if (req.method === 'POST') {
      const { body } = req.body || {};
      if (!body?.trim()) return res.status(400).json({ error: 'Message vide' });
      if (body.length > 2000) return res.status(400).json({ error: 'Message trop long (2000 caractères max)' });

      const inserted = await sql`
        INSERT INTO forum_posts (user_email, user_name, body)
        VALUES (${user.email}, ${user.name || user.email}, ${body.trim()})
        RETURNING id, created_at
      `;
      return res.json({ ok: true, id: inserted[0].id, createdAt: inserted[0].created_at });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id requis' });

      if (isAdmin(user)) {
        await sql`DELETE FROM forum_posts WHERE id = ${id}`;
      } else {
        await sql`DELETE FROM forum_posts WHERE id = ${id} AND user_email = ${user.email}`;
      }
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
