import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';
import webpush from 'web-push';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET manquant : définis cette variable d\'environnement avant de démarrer l\'application.');
}

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT || 'mailto:contact@agroai.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function sendPushToSubscriptions(sql, subs, payload) {
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      )
    )
  );
  // Nettoyer les abonnements expirés/invalides (410 Gone / 404)
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

function getAdmin(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return { error: 'Connexion requise', status: 401 };
  let user;
  try { user = jwt.verify(token, JWT_SECRET); }
  catch { return { error: 'Session expirée', status: 401 }; }
  if (!user.isAdmin) return { error: "Accès réservé à l'administrateur", status: 403 };
  return { user };
}

// Authentification simple : n'importe quel utilisateur connecté (admin ou non).
// Utilisé pour les actions qui doivent rester accessibles à tous (ex: signaler une réponse).
function getAnyUser(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return { error: 'Connexion requise', status: 401 };
  let user;
  try { user = jwt.verify(token, JWT_SECRET); }
  catch { return { error: 'Session expirée', status: 401 }; }
  return { user };
}

// Actions qui ne nécessitent PAS le rôle admin (accessibles à tout utilisateur connecté)
const USER_ACTIONS = new Set(['report_answer']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  // ── GET : liste des réponses signalées par les utilisateurs (admin uniquement) ──
  if (req.method === 'GET') {
    const { error, status } = getAdmin(req);
    if (error) return res.status(status).json({ error });
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS reported_answers (
          id SERIAL PRIMARY KEY,
          user_email TEXT NOT NULL,
          question TEXT,
          reponse TEXT,
          reason TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ DEFAULT NOW()
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

  // ── Auth : signaler une réponse reste accessible à tout utilisateur connecté, le reste est admin uniquement ──
  const isUserAction = USER_ACTIONS.has(action);
  const auth = isUserAction ? getAnyUser(req) : getAdmin(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const admin = auth.user;

  try {
    // ── SIGNALER UNE RÉPONSE INCORRECTE (accessible à tout utilisateur) ──
    if (action === 'report_answer') {
      const { email, question, reponse, reason } = req.body;
      await sql`
        CREATE TABLE IF NOT EXISTS reported_answers (
          id SERIAL PRIMARY KEY,
          user_email TEXT NOT NULL,
          question TEXT,
          reponse TEXT,
          reason TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      const inserted = await sql`
        INSERT INTO reported_answers (user_email, question, reponse, reason)
        VALUES (${email || admin.email}, ${question || ''}, ${reponse || ''}, ${reason || ''})
        RETURNING id
      `;
      return res.json({ ok: true, id: inserted[0]?.id });
    }

    // ── MARQUER UN SIGNALEMENT COMME TRAITÉ (admin) ──
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

    // ── SUPPRIMER UN COMPTE ──
    if (action === 'delete') {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Email requis' });
      if (email === admin.email) return res.status(400).json({ error: 'Impossible de supprimer son propre compte' });

      await sql`DELETE FROM messages WHERE user_email = ${email}`;
      const result = await sql`DELETE FROM users WHERE email = ${email} RETURNING email`;
      if (result.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });

      return res.json({ success: true, message: `Compte ${email} et son historique supprimés définitivement` });
    }

    // ── PROMOUVOIR / RÉTROGRADER UN ADMIN ──
    if (action === 'promote') {
      const { email, isAdmin } = req.body;
      if (!email) return res.status(400).json({ error: 'Email requis' });
      if (email === admin.email) return res.status(400).json({ error: 'Impossible de modifier ses propres droits' });

      const result = await sql`
        UPDATE users SET is_admin = ${isAdmin === true}
        WHERE email = ${email}
        RETURNING email, is_admin
      `;
      if (result.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });

      const label = isAdmin ? 'promu administrateur' : 'rétrogradé utilisateur simple';
      return res.json({ success: true, message: `${email} ${label}` });
    }

    // ── DIFFUSION (notification à tous les utilisateurs) ──
    if (action === 'broadcast') {
      const { type, title, body } = req.body;
      if (!body) return res.status(400).json({ error: 'Message requis' });

      const inserted = await sql`
        INSERT INTO notifications (type, title, body, created_by)
        VALUES (${type || 'info'}, ${title || 'Information'}, ${body}, ${admin.email})
        RETURNING id
      `;

      // Envoi Push réel à tous les abonnés (fonctionne même app fermée)
      try {
        const subs = await sql`SELECT endpoint, p256dh, auth FROM push_subscriptions`;
        if (subs.length) {
          await sendPushToSubscriptions(sql, subs, {
            title: title || 'Information', body, tag: 'notif-' + inserted[0]?.id
          });
        }
      } catch (e) { /* push best-effort : ne bloque pas la réponse si ça échoue */ }

      return res.json({ ok: true, id: inserted[0]?.id });
    }

    // ── MESSAGE PRIVÉ À UN UTILISATEUR ──
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
          await sendPushToSubscriptions(sql, subs, {
            title: subject || 'Message de votre administrateur', body, tag: 'msg-' + inserted[0]?.id
          });
        }
      } catch (e) {}

      return res.json({ ok: true, id: inserted[0]?.id });
    }

    // ── SUPPRIMER UNE NOTIFICATION / UN MESSAGE ENVOYÉ ──
    if (action === 'delete_message') {
      const { id, type } = req.body;
      if (!id) return res.status(400).json({ error: 'Identifiant requis' });

      if (type === 'dm') {
        await sql`DELETE FROM admin_messages WHERE id = ${id}`;
      } else {
        await sql`DELETE FROM notifications WHERE id = ${id}`;
      }
      return res.json({ ok: true });
    }

    // ── SUPPRIMER TOUT L'HISTORIQUE DES MESSAGES/NOTIFICATIONS ENVOYÉS ──
    if (action === 'delete_all_messages') {
      await sql`DELETE FROM notifications`;
      await sql`DELETE FROM admin_messages`;
      return res.json({ ok: true });
    }

    // ── SUPPRIMER UN MESSAGE PRÉCIS D'UNE CONVERSATION UTILISATEUR ──
    if (action === 'delete_conversation_message') {
      const { email, date } = req.body;
      if (!email || !date) return res.status(400).json({ error: 'Email et date requis' });

      const result = await sql`
        DELETE FROM messages
        WHERE user_email = ${email} AND created_at = ${date}
        RETURNING id
      `;
      return res.json({ ok: true, deleted: result.length });
    }

    // ── SUPPRIMER TOUTES LES CONVERSATIONS D'UN UTILISATEUR ──
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
