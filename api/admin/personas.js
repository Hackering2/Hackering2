// api/admin/personas.js
// Gestion des "personas" IA : plusieurs jeux de consignes nommés, un seul actif à la fois.
// Adapte les imports/l'auth ci-dessous à ce qu'utilise déjà api/admin/system-prompt.js
// (même driver Neon, même vérification de token admin) pour rester cohérent avec le reste du backend.

import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';

const sql = neon(process.env.DATABASE_URL);

// ── Remplace cette fonction par le helper d'auth déjà utilisé dans les autres
//    routes api/admin/*.js (ex. vérification du Bearer token + colonne is_admin).
async function requireAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  // TODO: remplacer par la même logique que les autres routes admin
  // (ex. vérifier le token dans la table users / sessions, colonne is_admin = true)
  const rows = await sql`
    SELECT email FROM users WHERE token = ${token} AND is_admin = true LIMIT 1
  `;
  return rows[0] || null;
}

export default async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Non autorisé.' });

  try {
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, name, key, instructions, active, created_at, updated_at
        FROM personas ORDER BY created_at ASC
      `;
      return res.status(200).json({ personas: rows });
    }

    if (req.method === 'POST') {
      const { name, key, instructions } = req.body || {};
      if (!name || !key) return res.status(400).json({ error: 'Nom et clé requis.' });
      const existing = await sql`SELECT id FROM personas WHERE key = ${key} LIMIT 1`;
      if (existing.length) return res.status(400).json({ error: 'Cette clé existe déjà.' });
      const id = crypto.randomUUID();
      await sql`
        INSERT INTO personas (id, name, key, instructions, active, created_at, updated_at)
        VALUES (${id}, ${name}, ${key}, ${instructions || ''}, false, now(), now())
      `;
      return res.status(200).json({ ok: true, id });
    }

    if (req.method === 'PATCH') {
      const { id, name, key, instructions, active } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id requis.' });

      // Activation : une seule persona active à la fois.
      if (typeof active === 'boolean') {
        if (active) {
          await sql`UPDATE personas SET active = false WHERE active = true`;
        }
        await sql`UPDATE personas SET active = ${active}, updated_at = now() WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }

      // Édition du contenu.
      await sql`
        UPDATE personas
        SET name = COALESCE(${name}, name),
            key = COALESCE(${key}, key),
            instructions = COALESCE(${instructions}, instructions),
            updated_at = now()
        WHERE id = ${id}
      `;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id requis.' });
      await sql`DELETE FROM personas WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Méthode non autorisée.' });
  } catch (err) {
    console.error('[api/admin/personas] erreur:', err);
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
}
