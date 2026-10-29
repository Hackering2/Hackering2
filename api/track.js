// api/track.js — journal des connexions (IP + localisation approximative)
//  POST : un utilisateur connecté enregistre sa session (appelé par le front après connexion)
//  GET  : l'administrateur liste les connexions récentes
// La localisation vient des en-têtes Vercel (pays/région/ville) : approximative, pas du GPS.
import { getUser, isAdmin, applyCors, rateLimit } from '../lib/auth.js';
import { db } from '../lib/keyPool.js';

const dec = v => { try { return decodeURIComponent(v || ''); } catch { return v || ''; } };

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0] : req.headers['x-real-ip'] || req.socket?.remoteAddress || '').trim();
}

async function ensureTable(sql) {
  await sql`CREATE TABLE IF NOT EXISTS login_events (
    id SERIAL PRIMARY KEY,
    user_email TEXT NOT NULL,
    ip TEXT, country TEXT, region TEXT, city TEXT,
    latitude TEXT, longitude TEXT, precise BOOLEAN DEFAULT false,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
}

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET, POST, OPTIONS')) return;
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Connexion requise.' });
  const sql = db();

  try {
    await ensureTable(sql);

    if (req.method === 'POST') {
      if (!rateLimit(`track:${user.email}`, 10)) return res.status(429).json({ error: 'Trop de requêtes.' });
      const h = req.headers;
      // Position GPS précise : envoyée par le front UNIQUEMENT si l'utilisateur a accepté
      // la demande de localisation de son navigateur/téléphone (navigator.geolocation).
      const body = req.body || {};
      const lat = (typeof body.lat === 'number') ? String(body.lat) : (h['x-vercel-ip-latitude'] || '');
      const lng = (typeof body.lng === 'number') ? String(body.lng) : (h['x-vercel-ip-longitude'] || '');
      const precise = typeof body.lat === 'number';
      await sql`INSERT INTO login_events (user_email, ip, country, region, city, latitude, longitude, precise, user_agent)
        VALUES (${user.email}, ${clientIp(req)}, ${h['x-vercel-ip-country'] || ''},
                ${dec(h['x-vercel-ip-country-region'])}, ${dec(h['x-vercel-ip-city'])},
                ${lat}, ${lng}, ${precise},
                ${String(h['user-agent'] || '').slice(0, 300)})`;
      return res.status(201).json({ success: true });
    }

    if (req.method === 'GET') {
      if (!isAdmin(user)) return res.status(403).json({ error: "Accès réservé à l'administrateur." });
      const email = req.query?.email;
      const rows = email
        ? await sql`SELECT * FROM login_events WHERE user_email = ${email} ORDER BY created_at DESC LIMIT 200`
        : await sql`SELECT * FROM login_events ORDER BY created_at DESC LIMIT 200`;
      return res.status(200).json({ events: rows });
    }

    return res.status(405).json({ error: 'Méthode non autorisée.' });
  } catch (e) {
    console.error('track:', e.message);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
}
