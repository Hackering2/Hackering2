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
  return user && (user.role === 'admin' || user.email === ADMIN_EMAIL);
}

// Masquer la clé : afficher seulement gsk_****...****xxxx
function maskKey(key) {
  if (!key || key.length < 12) return '••••••••••••';
  return key.substring(0, 6) + '••••••••••••' + key.slice(-4);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = getUser(req);
  if (!user || !isAdmin(user)) return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });

  const sql = neon(process.env.DATABASE_URL);

  // ── GET : lister toutes les clés ──
  if (req.method === 'GET') {
    try {
      const keys = await sql`
        SELECT id, label, key_preview, is_active, usage_count, last_used_at, created_at
        FROM api_keys
        ORDER BY created_at DESC
      `;
      // Compter les requêtes aujourd'hui
      const todayResult = await sql`
        SELECT COUNT(*) as count FROM messages
        WHERE created_at >= CURRENT_DATE
      `;
      return res.status(200).json({
        keys,
        todayRequests: todayResult[0]?.count ?? 0
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST : ajouter une clé ──
  if (req.method === 'POST') {
    const { label, key } = req.body || {};
    if (!key?.trim()) return res.status(400).json({ error: 'Clé API manquante.' });
    if (!key.startsWith('gsk_')) return res.status(400).json({ error: 'Format invalide. La clé doit commencer par gsk_' });

    try {
      // Vérifier que la clé n'existe pas déjà (par preview)
      const preview = maskKey(key);
      const exists = await sql`SELECT id FROM api_keys WHERE key_preview = ${preview}`;
      if (exists.length > 0) return res.status(409).json({ error: 'Cette clé est déjà enregistrée.' });

      await sql`
        INSERT INTO api_keys (label, key_value, key_preview, is_active, usage_count)
        VALUES (${label || 'Clé sans label'}, ${key.trim()}, ${preview}, true, 0)
      `;
      return res.status(201).json({ success: true, message: 'Clé ajoutée et active dans le pool de rotation.' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATCH : activer/désactiver une clé ──
  if (req.method === 'PATCH') {
    const { id, is_active } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID manquant.' });
    try {
      await sql`UPDATE api_keys SET is_active = ${is_active} WHERE id = ${id}`;
      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE : supprimer une clé ──
  if (req.method === 'DELETE') {
    const id = req.query?.id;
    if (!id) return res.status(400).json({ error: 'ID manquant.' });
    try {
      await sql`DELETE FROM api_keys WHERE id = ${id}`;
      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée.' });
}
