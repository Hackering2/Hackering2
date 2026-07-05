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

// Masquer la clé : affiche seulement les 4 premiers et 4 derniers caractères
function maskKey(key) {
  if (!key || key.length < 10) return '••••••••';
  return key.slice(0, 6) + '••••••••••••' + key.slice(-4);
}

const PREFIXES = { groq: 'gsk_', anthropic: 'sk-ant-' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = getUser(req);
  if (!user || !isAdmin(user)) return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });

  const sql = neon(process.env.DATABASE_URL);

  // ── GET : lister toutes les clés (Groq + Anthropic) ──
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, provider, label, key_preview, is_active, usage_count, error_count, last_used_at, created_at,
               rl_limit_requests, rl_remaining_requests, rl_reset_requests,
               rl_limit_tokens, rl_remaining_tokens, rl_reset_tokens, rl_updated_at
        FROM api_keys
        ORDER BY provider ASC, created_at DESC
      `;
      const keys = rows.map(k => ({
        id: k.id,
        provider: k.provider,
        label: k.label,
        keyPreview: k.key_preview,
        active: k.is_active,
        usageCount: k.usage_count,
        errorCount: k.error_count || 0,
        lastUsedAt: k.last_used_at,
        createdAt: k.created_at,
        rateLimit: (k.rl_limit_requests != null || k.rl_limit_tokens != null) ? {
          limitRequests: k.rl_limit_requests,
          remainingRequests: k.rl_remaining_requests,
          resetRequests: k.rl_reset_requests,
          limitTokens: k.rl_limit_tokens,
          remainingTokens: k.rl_remaining_tokens,
          resetTokens: k.rl_reset_tokens,
          updatedAt: k.rl_updated_at
        } : null
      }));

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
    const { provider, label, key } = req.body || {};
    if (!provider || !PREFIXES[provider]) return res.status(400).json({ error: 'Provider invalide (groq ou anthropic attendu).' });
    if (!key?.trim()) return res.status(400).json({ error: 'Clé API manquante.' });
    if (!key.trim().startsWith(PREFIXES[provider])) {
      return res.status(400).json({ error: `Format invalide. Une clé ${provider} doit commencer par "${PREFIXES[provider]}".` });
    }

    try {
      const preview = maskKey(key.trim());
      const exists = await sql`SELECT id FROM api_keys WHERE key_preview = ${preview} AND provider = ${provider}`;
      if (exists.length > 0) return res.status(409).json({ error: 'Cette clé est déjà enregistrée.' });

      await sql`
        INSERT INTO api_keys (provider, label, key_value, key_preview, is_active, usage_count, error_count)
        VALUES (${provider}, ${label || provider}, ${key.trim()}, ${preview}, true, 0, 0)
      `;
      return res.status(201).json({ success: true, message: 'Clé ajoutée et active dans le pool de rotation.' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PATCH : activer/désactiver une clé ──
  if (req.method === 'PATCH') {
    const { id, active } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID manquant.' });
    try {
      // Réactiver une clé remet aussi son compteur d'erreurs à zéro
      await sql`UPDATE api_keys SET is_active = ${active}, error_count = CASE WHEN ${active} THEN 0 ELSE error_count END WHERE id = ${id}`;
      return res.status(200).json({ success: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE : supprimer une clé (id envoyé dans le corps JSON) ──
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
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
