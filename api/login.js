import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

// Anti-bruteforce : seuils de blocage
const MAX_FAILURES = 5;          // tentatives échouées autorisées
const WINDOW_MINUTES = 15;       // fenêtre glissante de comptage
const BLOCK_MINUTES = 30;        // durée du blocage une fois le seuil dépassé

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { email, password } = req.body;
  const ip = getClientIp(req);
  const sql = neon(process.env.DATABASE_URL);

  // Migration idempotente — même table que celle lue par le panel Sécurité (community.js?type=security)
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS login_attempts (
        id SERIAL PRIMARY KEY,
        email TEXT,
        ip TEXT,
        success BOOLEAN NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
  } catch (e) { console.error('Migration login_attempts error:', e.message); }

  async function logAttempt(success, reason) {
    try {
      await sql`INSERT INTO login_attempts (email, ip, success, reason) VALUES (${email || null}, ${ip}, ${success}, ${reason || null})`;
    } catch (e) { console.error('Log login attempt error:', e.message); }
  }

  try {
    // ── Vérification du blocage anti-bruteforce (par IP ET par email) ──
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
