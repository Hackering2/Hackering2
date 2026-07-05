import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin';

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
  const type = req.query?.type;

  try {
    // ══════════════════════════════════════════
    //  FORUM GÉNÉRAL
    // ══════════════════════════════════════════
    if (type === 'forum') {
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
          FROM forum_posts ORDER BY created_at ASC LIMIT 300
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
    }

    // ══════════════════════════════════════════
    //  DISCUSSION AVEC L'ADMIN (bidirectionnel)
    // ══════════════════════════════════════════
    if (type === 'inbox') {
      try {
        await sql`ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS from_email TEXT`;
        await sql`UPDATE admin_messages SET from_email = ${ADMIN_EMAIL} WHERE from_email IS NULL`;
      } catch (e) { console.error('Migration admin_messages error:', e.message); }

      if (req.method === 'GET') {
        const targetEmail = (isAdmin(user) && req.query?.email) ? req.query.email : user.email;
        const rows = await sql`
          SELECT id, from_email, to_email, subject, body, created_at, read
          FROM admin_messages
          WHERE to_email = ${targetEmail} OR from_email = ${targetEmail}
          ORDER BY created_at ASC LIMIT 300
        `;
        if (!isAdmin(user) || req.query?.email === user.email) {
          await sql`UPDATE admin_messages SET read = true WHERE to_email = ${user.email} AND read = false`;
        }
        return res.json({
          messages: rows.map(m => ({
            id: m.id, fromEmail: m.from_email, toEmail: m.to_email,
            fromAdmin: m.from_email === ADMIN_EMAIL || m.from_email !== targetEmail,
            subject: m.subject, body: m.body, createdAt: m.created_at, read: m.read
          })),
          withEmail: targetEmail
        });
      }

      if (req.method === 'POST') {
        const { body, toEmail } = req.body || {};
        if (!body?.trim()) return res.status(400).json({ error: 'Message vide' });
        if (body.length > 2000) return res.status(400).json({ error: 'Message trop long (2000 caractères max)' });
        let from, to, subject;
        if (isAdmin(user)) {
          if (!toEmail) return res.status(400).json({ error: 'Destinataire requis' });
          from = user.email; to = toEmail; subject = 'Message de votre administrateur';
        } else {
          from = user.email; to = ADMIN_EMAIL; subject = `Réponse de ${user.name || user.email}`;
        }
        const inserted = await sql`
          INSERT INTO admin_messages (from_email, to_email, subject, body, read)
          VALUES (${from}, ${to}, ${subject}, ${body.trim()}, false)
          RETURNING id, created_at
        `;
        return res.json({ ok: true, id: inserted[0].id, createdAt: inserted[0].created_at });
      }
    }

    // ══════════════════════════════════════════
    //  ABONNEMENTS PUSH (notifications en arrière-plan)
    // ══════════════════════════════════════════
    if (type === 'push') {
      await sql`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id SERIAL PRIMARY KEY,
          user_email TEXT NOT NULL,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;

      if (req.method === 'POST') {
        const { subscription } = req.body || {};
        if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
          return res.status(400).json({ error: 'Abonnement Push invalide' });
        }
        await sql`
          INSERT INTO push_subscriptions (user_email, endpoint, p256dh, auth)
          VALUES (${user.email}, ${subscription.endpoint}, ${subscription.keys.p256dh}, ${subscription.keys.auth})
          ON CONFLICT (endpoint) DO UPDATE SET user_email = ${user.email}, p256dh = ${subscription.keys.p256dh}, auth = ${subscription.keys.auth}
        `;
        return res.json({ success: true });
      }

      if (req.method === 'DELETE') {
        const { endpoint } = req.body || {};
        if (endpoint) {
          await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND user_email = ${user.email}`;
        } else {
          await sql`DELETE FROM push_subscriptions WHERE user_email = ${user.email}`;
        }
        return res.json({ success: true });
      }
    }

    return res.status(400).json({ error: 'Paramètre "type" invalide ou manquant (forum, inbox, push)' });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
