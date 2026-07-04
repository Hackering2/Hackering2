import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

function getAdmin(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return { error: 'Connexion requise', status: 401 };
  let user;
  try { user = jwt.verify(token, JWT_SECRET); }
  catch { return { error: 'Session expirée', status: 401 }; }
  if (!user.isAdmin) return { error: "Accès réservé à l'administrateur", status: 403 };
  return { user };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { error, status, user: admin } = getAdmin(req);
  if (error) return res.status(status).json({ error });

  const { action } = req.body || {};
  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── BLOQUER / DÉBLOQUER UN UTILISATEUR ──
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
