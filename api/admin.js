import { kv } from '@vercel/kv';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Connexion requise' });

  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expirée' });
  }

  if (!user.isAdmin) {
    return res.status(403).json({ error: 'Accès réservé à l\'administrateur' });
  }

  // Récupérer la liste de tous les utilisateurs
  const allEmails = (await kv.get('users:list')) || [];

  const result = [];
  for (const email of allEmails) {
    const userData = await kv.get(`user:${email}`);
    const convo = (await kv.get(`convo:${email}`)) || [];
    result.push({
      email,
      name: userData?.name || email,
      isAdmin: userData?.isAdmin || false,
      createdAt: userData?.createdAt,
      messageCount: convo.length,
      conversation: convo
    });
  }

  return res.json({ users: result });
}
