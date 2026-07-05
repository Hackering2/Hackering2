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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Connexion requise' });

  const sql = neon(process.env.DATABASE_URL);

  // Migration idempotente : ajoute la colonne from_email si elle n'existe pas encore,
  // et rattribue les anciens messages (envoyés uniquement par l'admin jusqu'ici) à l'admin.
  try {
    await sql`ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS from_email TEXT`;
    await sql`UPDATE admin_messages SET from_email = ${ADMIN_EMAIL} WHERE from_email IS NULL`;
  } catch (e) { console.error('Migration admin_messages error:', e.message); }

  try {
    if (req.method === 'GET') {
      // Un utilisateur voit son propre fil ; l'admin peut consulter le fil de n'importe quel utilisateur via ?email=
      const targetEmail = (isAdmin(user) && req.query?.email) ? req.query.email : user.email;

      const rows = await sql`
        SELECT id, from_email, to_email, subject, body, created_at, read
        FROM admin_messages
        WHERE to_email = ${targetEmail} OR from_email = ${targetEmail}
        ORDER BY created_at ASC
        LIMIT 300
      `;

      // Marquer comme lus les messages reçus par l'utilisateur qui consulte son propre fil
      if (!isAdmin(user) || req.query?.email === user.email) {
        await sql`UPDATE admin_messages SET read = true WHERE to_email = ${user.email} AND read = false`;
      }

      return res.json({
        messages: rows.map(m => ({
          id: m.id,
          fromEmail: m.from_email,
          toEmail: m.to_email,
          fromAdmin: m.from_email === ADMIN_EMAIL || m.from_email !== targetEmail,
          subject: m.subject,
          body: m.body,
          createdAt: m.created_at,
          read: m.read
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
        from = user.email;
        to = toEmail;
        subject = 'Message de votre administrateur';
      } else {
        from = user.email;
        to = ADMIN_EMAIL;
        subject = `Réponse de ${user.name || user.email}`;
      }

      const inserted = await sql`
        INSERT INTO admin_messages (from_email, to_email, subject, body, read)
        VALUES (${from}, ${to}, ${subject}, ${body.trim()}, false)
        RETURNING id, created_at
      `;
      return res.json({ ok: true, id: inserted[0].id, createdAt: inserted[0].created_at });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
