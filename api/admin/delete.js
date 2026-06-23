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

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });
  if (email === admin.email) return res.status(400).json({ error: 'Impossible de supprimer son propre compte' });

  try {
    const sql = neon(process.env.DATABASE_URL);

    // Supprimer les messages d'abord (contrainte FK)
    await sql`DELETE FROM messages WHERE user_email = ${email}`;

    // Supprimer l'utilisateur
    const result = await sql`DELETE FROM users WHERE email = ${email} RETURNING email`;

    if (result.length === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    return res.json({ success: true, message: `Compte ${email} et son historique supprimés définitivement` });

  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
