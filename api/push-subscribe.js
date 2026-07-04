import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Connexion requise' });

  let user;
  try { user = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Session expirée' }); }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Table auto-créée si elle n'existe pas encore
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

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
