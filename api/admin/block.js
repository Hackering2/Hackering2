import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Connexion requise' });

  let admin;
  try { admin = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Session expirée' }); }

  if (!admin.isAdmin) return res.status(403).json({ error: 'Accès admin requis' });

  const { email, blocked } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });
  if (email === admin.email) return res.status(400).json({ error: 'Impossible de se bloquer soi-même' });

  try {
    const sql = neon(process.env.DATABASE_URL);

    if (blocked) {
      await sql`
        UPDATE users
        SET blocked = TRUE, blocked_at = NOW()
        WHERE email = ${email}
      `;
    } else {
      await sql`
        UPDATE users
        SET blocked = FALSE, blocked_at = NULL
        WHERE email = ${email}
      `;
    }

    const action = blocked ? 'bloqué' : 'débloqué';
    return res.json({ success: true, message: `Utilisateur ${email} ${action} avec succès` });

  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
