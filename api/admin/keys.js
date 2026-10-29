// api/admin/keys.js
// Regroupe les anciens admin/keys.js, admin/actions.js, admin/personas.js et
// admin/system-prompt.js en UNE seule fonction serverless, routée par ?a=…
// (a=keys par défaut, pour ne pas casser les appels existants à /api/admin/keys).
// Fusion nécessaire pour rester sous la limite de fonctions du plan Vercel —
// chaque bloc ci-dessous est le code d'origine, inchangé dans sa logique,
// à l'exception de personas (auth alignée sur le JWT utilisé partout ailleurs :
// le fichier reçu utilisait une colonne "token" en base, incohérente avec le
// reste du backend, qui aurait empêché la fonctionnalité de marcher).
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import webpush from 'web-push';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET manquant : définis cette variable d\'environnement avant de démarrer l\'application.');
}
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

function getUser(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
function isAdmin(user) {
  return !!user && (user.isAdmin === true || user.role === 'admin' || user.email === ADMIN_EMAIL);
}

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT || 'mailto:contact@agroai.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const section = req.query?.a || 'keys';
  const sql = neon(process.env.DATABASE_URL);

  if (section === 'actions') return handleActions(req, res, sql);
  if (section === 'personas') return handlePersonas(req, res, sql);
  if (section === 'system-prompt') return handleSystemPrompt(req, res, sql);
  return handleKeys(req, res, sql);
}

// ═══════════════════════════════════════════════════════════════
//  a=keys (défaut) — gestion des clés API (ex admin/keys.js)
// ═══════════════════════════════════════════════════════════════
function maskKey(key) {
  if (!key || key.length < 10) return '••••••••';
  return key.slice(0, 6) + '••••••••••••' + key.slice(-4);
}
const PREFIXES = { groq: 'gsk_', anthropic: 'sk-ant-' };

async function handleKeys(req, res, sql) {
  const user = getUser(req);
  if (!user || !isAdmin(user)) return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });

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
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

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
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'PATCH') {
    const { id, active } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID manquant.' });
    try {
      await sql`UPDATE api_keys SET is_active = ${active}, error_count = CASE WHEN ${active} THEN 0 ELSE error_count END WHERE id = ${id}`;
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID manquant.' });
    try {
      await sql`DELETE FROM api_keys WHERE id = ${id}`;
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée.' });
}

// ═══════════════════════════════════════════════════════════════
//  a=actions — actions admin + signalement (ex admin/actions.js)
// ═══════════════════════════════════════════════════════════════
async function sendPushToSubscriptions(sql, subs, payload) {
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      )
    )
  );
  const dead = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected' && (r.reason?.statusCode === 410 || r.reason?.statusCode === 404)) {
      dead.push(subs[i].endpoint);
    }
  });
  if (dead.length) {
    await sql`DELETE FROM push_subscriptions WHERE endpoint = ANY(${dead})`;
  }
}

const USER_ACTIONS = new Set(['report_answer']);

async function handleActions(req, res, sql) {
  if (req.method === 'GET') {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'Connexion requise' });
    if (!isAdmin(user)) return res.status(403).json({ error: "Accès réservé à l'administrateur" });
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS reported_answers (
          id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, question TEXT, reponse TEXT,
          reason TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      const rows = await sql`
        SELECT id, user_email, question, reponse, reason, status, created_at
        FROM reported_answers ORDER BY created_at DESC LIMIT 200
      `;
      return res.json({ reports: rows });
    } catch (err) {
      return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { action } = req.body || {};
  const isUserAction = USER_ACTIONS.has(action);
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Connexion requise' });
  if (!isUserAction && !isAdmin(user)) return res.status(403).json({ error: "Accès réservé à l'administrateur" });
  const admin = user;

  try {
    if (action === 'report_answer') {
      const { email, question, reponse, reason } = req.body;
      await sql`
        CREATE TABLE IF NOT EXISTS reported_answers (
          id SERIAL PRIMARY KEY, user_email TEXT NOT NULL, question TEXT, reponse TEXT,
          reason TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      const inserted = await sql`
        INSERT INTO reported_answers (user_email, question, reponse, reason)
        VALUES (${email || admin.email}, ${question || ''}, ${reponse || ''}, ${reason || ''})
        RETURNING id
      `;
      return res.json({ ok: true, id: inserted[0]?.id });
    }

    if (action === 'resolve_report') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Identifiant requis' });
      await sql`UPDATE reported_answers SET status = 'resolved' WHERE id = ${id}`;
      return res.json({ ok: true });
    }

    if (action === 'block') {
      const { email, blocked } = req.body;
      if (!email) return res.status(400).json({ error: 'Email requis' });
      if (email === admin.email) return res.status(400).json({ error: 'Impossible de se bloquer soi-même' });
      if (blocked) {
        await sql`UPDATE users SET blocked = TRUE, blocked_at = NOW() WHERE email = ${email}`;
      } else {
        await sql`UPDATE users SET blocked = FALSE, blocked_at = NULL WHERE email = ${email}`;
      }
      const label = blocked ? 'bloqué' : 'débloqué';
      return res.json({ success: true, message: `Utilisateur ${email} ${label} avec succès` });
    }

    if (action === 'delete') {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Email requis' });
      if (email === admin.email) return res.status(400).json({ error: 'Impossible de supprimer son propre compte' });
      await sql`DELETE FROM messages WHERE user_email = ${email}`;
      const result = await sql`DELETE FROM users WHERE email = ${email} RETURNING email`;
      if (result.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
      return res.json({ success: true, message: `Compte ${email} et son historique supprimés définitivement` });
    }

    if (action === 'promote') {
      const { email, isAdmin: targetAdmin } = req.body;
      if (!email) return res.status(400).json({ error: 'Email requis' });
      if (email === admin.email) return res.status(400).json({ error: 'Impossible de modifier ses propres droits' });
      const result = await sql`
        UPDATE users SET is_admin = ${targetAdmin === true}
        WHERE email = ${email}
        RETURNING email, is_admin
      `;
      if (result.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
      const label = targetAdmin ? 'promu administrateur' : 'rétrogradé utilisateur simple';
      return res.json({ success: true, message: `${email} ${label}` });
    }

    if (action === 'broadcast') {
      const { type, title, body } = req.body;
      if (!body) return res.status(400).json({ error: 'Message requis' });
      const inserted = await sql`
        INSERT INTO notifications (type, title, body, created_by)
        VALUES (${type || 'info'}, ${title || 'Information'}, ${body}, ${admin.email})
        RETURNING id
      `;
      try {
        const subs = await sql`SELECT endpoint, p256dh, auth FROM push_subscriptions`;
        if (subs.length) {
          await sendPushToSubscriptions(sql, subs, { title: title || 'Information', body, tag: 'notif-' + inserted[0]?.id });
        }
      } catch (e) {}
      return res.json({ ok: true, id: inserted[0]?.id });
    }

    if (action === 'message') {
      const { email, subject, body } = req.body;
      if (!email || !body) return res.status(400).json({ error: 'Destinataire et message requis' });
      const inserted = await sql`
        INSERT INTO admin_messages (to_email, subject, body)
        VALUES (${email}, ${subject || 'Message de votre administrateur'}, ${body})
        RETURNING id
      `;
      try {
        const subs = await sql`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_email = ${email}`;
        if (subs.length) {
          await sendPushToSubscriptions(sql, subs, { title: subject || 'Message de votre administrateur', body, tag: 'msg-' + inserted[0]?.id });
        }
      } catch (e) {}
      return res.json({ ok: true, id: inserted[0]?.id });
    }

    if (action === 'delete_message') {
      const { id, type } = req.body;
      if (!id) return res.status(400).json({ error: 'Identifiant requis' });
      if (type === 'dm') { await sql`DELETE FROM admin_messages WHERE id = ${id}`; }
      else { await sql`DELETE FROM notifications WHERE id = ${id}`; }
      return res.json({ ok: true });
    }

    if (action === 'delete_all_messages') {
      await sql`DELETE FROM notifications`;
      await sql`DELETE FROM admin_messages`;
      return res.json({ ok: true });
    }

    if (action === 'delete_conversation_message') {
      const { email, date } = req.body;
      if (!email || !date) return res.status(400).json({ error: 'Email et date requis' });
      const result = await sql`
        DELETE FROM messages WHERE user_email = ${email} AND created_at = ${date} RETURNING id
      `;
      return res.json({ ok: true, deleted: result.length });
    }

    if (action === 'delete_all_user_conversations') {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Email requis' });
      const result = await sql`DELETE FROM messages WHERE user_email = ${email} RETURNING id`;
      return res.json({ ok: true, deleted: result.length });
    }

    return res.status(400).json({ error: `Action inconnue : "${action}"` });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
//  a=personas — jeux de consignes IA (ex admin/personas.js)
//  Auth alignée sur le JWT (le fichier d'origine utilisait une colonne
//  "token" en base, incompatible avec le reste du backend).
// ═══════════════════════════════════════════════════════════════
async function handlePersonas(req, res, sql) {
  const user = getUser(req);
  if (!user || !isAdmin(user)) return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS personas (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE,
        instructions TEXT DEFAULT '', active BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    if (req.method === 'GET') {
      const rows = await sql`SELECT id, name, key, instructions, active, created_at, updated_at FROM personas ORDER BY created_at ASC`;
      return res.status(200).json({ personas: rows });
    }

    if (req.method === 'POST') {
      const { name, key, instructions } = req.body || {};
      if (!name || !key) return res.status(400).json({ error: 'Nom et clé requis.' });
      const existing = await sql`SELECT id FROM personas WHERE key = ${key} LIMIT 1`;
      if (existing.length) return res.status(400).json({ error: 'Cette clé existe déjà.' });
      const id = crypto.randomUUID();
      await sql`
        INSERT INTO personas (id, name, key, instructions, active, created_at, updated_at)
        VALUES (${id}, ${name}, ${key}, ${instructions || ''}, false, now(), now())
      `;
      return res.status(200).json({ ok: true, id });
    }

    if (req.method === 'PATCH') {
      const { id, name, key, instructions, active } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id requis.' });
      if (typeof active === 'boolean') {
        if (active) { await sql`UPDATE personas SET active = false WHERE active = true`; }
        await sql`UPDATE personas SET active = ${active}, updated_at = now() WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }
      await sql`
        UPDATE personas SET
          name = COALESCE(${name}, name),
          key = COALESCE(${key}, key),
          instructions = COALESCE(${instructions}, instructions),
          updated_at = now()
        WHERE id = ${id}
      `;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id requis.' });
      await sql`DELETE FROM personas WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Méthode non autorisée.' });
  } catch (err) {
    console.error('[admin/keys?a=personas] erreur:', err.message);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
}

// ═══════════════════════════════════════════════════════════════
//  a=system-prompt — consignes IA globales (ex admin/system-prompt.js)
// ═══════════════════════════════════════════════════════════════
const CONFIG_KEY = 'ai_extra_instructions';
const MAX_LENGTH = 4000;

async function handleSystemPrompt(req, res, sql) {
  const user = getUser(req);
  if (!user || !isAdmin(user)) return res.status(403).json({ error: 'Accès réservé à l\'administrateur.' });

  if (req.method === 'GET') {
    try {
      const rows = await sql`SELECT value, updated_at, updated_by FROM system_config WHERE key = ${CONFIG_KEY}`;
      return res.status(200).json({
        instructions: rows[0]?.value || '',
        updatedAt: rows[0]?.updated_at || null,
        updatedBy: rows[0]?.updated_by || null
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

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
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée.' });
}
