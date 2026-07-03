import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const CONFIG_KEY = 'ai_extra_instructions';
const MAX_LENGTH = 4000;

function getUser(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function isAdmin(user) {
  return user && (user.role === 'admin' || user.email === ADMIN_EMAIL);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = getUser(req);
  if (!user || !isAdmin(user)) return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });

  const sql = neon(process.env.DATABASE_URL);

  // ── GET : lire les instructions actuelles ──
  if (req.method === 'GET') {
    try {
      const rows = await sql`SELECT value, updated_at, updated_by FROM system_config WHERE key = ${CONFIG_KEY}`;
      return res.status(200).json({
        instructions: rows[0]?.value || '',
        updatedAt: rows[0]?.updated_at || null,
        updatedBy: rows[0]?.updated_by || null
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST : mettre à jour les instructions ──
  if (req.method === 'POST') {
    const { instructions } = req.body || {};
    const text = (instructions || '').toString().slice(0, MAX_LENGTH);
    try {
      await sql`
        INSERT INTO system_config (key, value, updated_at, updated_by)
        VALUES (${CONFIG_KEY}, ${text}, NOW(), ${user.email})
        ON CONFLICT (key) DO UPDATE SET value = ${text}, updated_at = NOW(), updated_by = ${user.email}
      `;
      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée.' });
}
