import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { email, password } = req.body;

  try {
    const sql = neon(process.env.DATABASE_URL);

    const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const user = rows[0];

    // Vérifier si le compte est bloqué
    if (user.blocked) {
      return res.status(403).json({ error: 'Votre compte a été suspendu. Contactez l\'administrateur.' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const token = jwt.sign(
      { email: user.email, name: user.name, isAdmin: user.is_admin },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.json({ success: true, token, name: user.name, isAdmin: user.is_admin });

  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
