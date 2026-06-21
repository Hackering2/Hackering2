import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';

// ⚠️ REMPLACEZ CET E-MAIL par le vôtre — ce sera votre compte administrateur
const ADMIN_EMAIL = 'toavinarakotoharimalala@gmail.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { email, password, name } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);

    const existing = await sql`SELECT email FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const isAdmin = email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
    const displayName = name || email.split('@')[0];

    await sql`
      INSERT INTO users (email, password, name, is_admin)
      VALUES (${email}, ${hashedPassword}, ${displayName}, ${isAdmin})
    `;

    return res.json({ success: true, message: 'Compte créé avec succès', isAdmin });

  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
