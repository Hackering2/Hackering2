import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';
const ANTHROPIC_VERSION = '2023-06-01';

function getUserFromToken(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Connexion requise.' });

  const { model, max_tokens, system, messages } = req.body || {};
  if (!messages) return res.status(400).json({ error: 'messages manquant' });

  try {
    // ── ROTATION DES CLÉS API (Anthropic uniquement) ──
    const sql = neon(process.env.DATABASE_URL);

    let activeKeys = [];
    try {
      const rows = await sql`
        SELECT id, key_value FROM api_keys
        WHERE is_active = true AND provider = 'anthropic'
        ORDER BY usage_count ASC, id ASC
      `;
      activeKeys = rows;
    } catch(e) { console.error('DB apikeys error:', e.message); }

    // Pool : clés DB en premier, clé env en fallback
    const keyPool = [
      ...activeKeys.map(k => ({ id: k.id, key: k.key_value, fromDb: true })),
      { id: null, key: process.env.ANTHROPIC_API_KEY, fromDb: false }
    ].filter(k => k.key);

    if (!keyPool.length) return res.status(500).json({ error: 'Aucune clé API Anthropic disponible.' });

    let anthropicResponse, data, usedKey;
    for (const candidate of keyPool) {
      try {
        anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': candidate.key,
            'anthropic-version': ANTHROPIC_VERSION
          },
          body: JSON.stringify({
            model: model || 'claude-sonnet-4-6',
            max_tokens: max_tokens || 4000,
            system: system || undefined,
            messages
          })
        });
        data = await anthropicResponse.json();
        if (anthropicResponse.ok) { usedKey = candidate; break; }

        // 401 (clé invalide) ou 429 (rate limit / crédit épuisé) → clé suivante
        if (anthropicResponse.status === 401 || anthropicResponse.status === 429) {
          console.warn(`Clé Anthropic ${candidate.id || 'env'} indisponible (${anthropicResponse.status}), rotation…`);
          if (candidate.fromDb) {
            try {
              if (anthropicResponse.status === 401) {
                await sql`UPDATE api_keys SET is_active=false, error_count=error_count+1 WHERE id=${candidate.id}`;
              } else {
                await sql`UPDATE api_keys SET error_count=error_count+1 WHERE id=${candidate.id}`;
              }
            } catch(_) {}
          }
          continue;
        }
        // Autre erreur (400, 500…) → on arrête, ce n'est pas un problème de clé
        return res.status(anthropicResponse.status).json({ error: data.error?.message || 'Erreur Anthropic' });
      } catch(fetchErr) {
        console.error('Fetch error clé Anthropic', candidate.id, fetchErr.message);
        continue;
      }
    }

    if (!anthropicResponse?.ok || !data) {
      return res.status(503).json({ error: 'Toutes les clés Anthropic sont épuisées ou invalides. Veuillez en ajouter dans le panneau Admin.' });
    }

    if (usedKey?.fromDb && usedKey.id) {
      try {
        await sql`UPDATE api_keys SET usage_count = usage_count + 1, error_count = 0, last_used_at = NOW() WHERE id = ${usedKey.id}`;
      } catch(e) { console.error('Usage count error:', e.message); }
    }

    // On renvoie la réponse Anthropic telle quelle (le front-end lit data.content[].text)
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Impossible de joindre Anthropic : ' + err.message });
  }
}
