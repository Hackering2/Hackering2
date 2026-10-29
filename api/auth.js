// api/auth.js
// Regroupe les anciens login.js et register.js en une seule fonction serverless,
// routée par ?a=login (défaut) / ?a=register. Fusion nécessaire pour rester sous
// la limite de fonctions du plan Vercel — chaque bloc ci-dessous est le code
// d'origine, inchangé dans sa logique.
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

  const sql = neon(process.env.DATABASE_URL);
  if (req.query?.a === 'register') return handleRegister(req, res, sql);
  return handleLogin(req, res, sql);
}

// ═══════════════════════════════════════════════════════════════
//  a=login (défaut) — ex login.js (anti-bruteforce inchangé)
// ═══════════════════════════════════════════════════════════════
const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;
const BLOCK_MINUTES = 30;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

async function handleLogin(req, res, sql) {
  const { email, password } = req.body;
  const ip = getClientIp(req);

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS login_attempts (
        id SERIAL PRIMARY KEY, email TEXT, ip TEXT, success BOOLEAN NOT NULL,
        reason TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
  } catch (e) { console.error('Migration login_attempts error:', e.message); }

  async function logAttempt(success, reason) {
    try {
      await sql`INSERT INTO login_attempts (email, ip, success, reason) VALUES (${email || null}, ${ip}, ${success}, ${reason || null})`;
    } catch (e) { console.error('Log login attempt error:', e.message); }
  }

  try {
    const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60000).toISOString();
    const recentFailures = await sql`
      SELECT COUNT(*) as count FROM login_attempts
      WHERE success = false AND created_at >= ${windowStart}
      AND (ip = ${ip} OR email = ${email})
    `;
    const failureCount = Number(recentFailures[0]?.count || 0);

    if (failureCount >= MAX_FAILURES) {
      const lastFailure = await sql`
        SELECT created_at FROM login_attempts
        WHERE success = false AND (ip = ${ip} OR email = ${email})
        ORDER BY created_at DESC LIMIT 1
      `;
      const lastFailTime = lastFailure[0]?.created_at ? new Date(lastFailure[0].created_at) : null;
      const blockedUntil = lastFailTime ? new Date(lastFailTime.getTime() + BLOCK_MINUTES * 60000) : null;

      if (blockedUntil && blockedUntil > new Date()) {
        const minutesLeft = Math.ceil((blockedUntil - new Date()) / 60000);
        await logAttempt(false, 'blocked_bruteforce');
        return res.status(429).json({
          error: `Trop de tentatives échouées. Réessaie dans ${minutesLeft} minute(s).`
        });
      }
    }

    const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
    if (rows.length === 0) {
      await logAttempt(false, 'unknown_email');
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const user = rows[0];

    if (user.blocked) {
      await logAttempt(false, 'account_blocked');
      return res.status(403).json({ error: 'Votre compte a été suspendu. Contactez l\'administrateur.' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      await logAttempt(false, 'wrong_password');
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    await logAttempt(true, null);

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

// ═══════════════════════════════════════════════════════════════
//  a=register — ex register.js
// ═══════════════════════════════════════════════════════════════
// ADMIN_EMAIL vient de la variable d'environnement déjà utilisée ailleurs dans le
// backend ; la valeur d'origine (en dur dans le fichier) reste en secours pour ne
// rien changer si cette variable n'est pas encore définie sur Vercel.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'toavinarakotoharimalala@gmail.com';

async function handleRegister(req, res, sql) {
  const { email, password, name } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  try {
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
