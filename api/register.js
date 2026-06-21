import { kv } from '@vercel/kv';
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

  const existing = await kv.get(`user:${email}`);
  if (existing) {
    return res.status(409).json({ error: 'Cet email est déjà utilisé' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const isAdmin = email.toLowerCase() === ADMIN_EMAIL.toLowerCase();

  await kv.set(`user:${email}`, {
    email,
    password: hashedPassword,
    name: name || email.split('@')[0],
    isAdmin,
    createdAt: new Date().toISOString()
  });

  // Ajouter à la liste globale des utilisateurs
  const allUsers = (await kv.get('users:list')) || [];
  if (!allUsers.includes(email)) {
    allUsers.push(email);
    await kv.set('users:list', allUsers);
  }

  return res.json({ success: true, message: 'Compte créé avec succès', isAdmin });
}
