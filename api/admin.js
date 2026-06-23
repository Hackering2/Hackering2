import { neon } from '@neondatabase/serverless';
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
  try { user = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Session expirée' }); }

  if (!user.isAdmin) return res.status(403).json({ error: "Accès réservé à l'administrateur" });

  try {
    const sql = neon(process.env.DATABASE_URL);

    // Tous les utilisateurs avec leurs stats
    const users = await sql`
      SELECT
        u.email, u.name, u.is_admin, u.blocked, u.created_at,
        COUNT(m.id)::int AS message_count
      FROM users u
      LEFT JOIN messages m ON m.user_email = u.email
      GROUP BY u.email, u.name, u.is_admin, u.blocked, u.created_at
      ORDER BY u.created_at DESC
    `;

    // Stats globales
    const totalMessages = await sql`SELECT COUNT(*)::int AS count FROM messages`;
    const todayMessages = await sql`
      SELECT COUNT(*)::int AS count FROM messages
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    `;
    const weekMessages = await sql`
      SELECT COUNT(*)::int AS count FROM messages
      WHERE created_at >= NOW() - INTERVAL '7 days'
    `;

    // Top questions
    const topQuestions = await sql`
      SELECT question, COUNT(*)::int AS count
      FROM messages
      GROUP BY question
      ORDER BY count DESC
      LIMIT 10
    `;

    // Activité par jour (7 derniers jours)
    const activity = await sql`
      SELECT
        to_char(created_at, 'DD/MM') AS day,
        COUNT(*)::int AS count
      FROM messages
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY to_char(created_at, 'DD/MM'), DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `;

    // Secteurs les plus utilisés (basé sur les questions)
    const sectors = await sql`
      SELECT
        CASE
          WHEN question ILIKE '%viande%' OR question ILIKE '%charcuterie%' THEN 'Viande/Charcuterie'
          WHEN question ILIKE '%lait%' OR question ILIKE '%fromage%' THEN 'Laiterie/Fromagerie'
          WHEN question ILIKE '%céréale%' OR question ILIKE '%farine%' THEN 'Céréales/Meunerie'
          WHEN question ILIKE '%conserve%' OR question ILIKE '%appertisation%' THEN 'Conserves'
          WHEN question ILIKE '%boisson%' OR question ILIKE '%bière%' OR question ILIKE '%vin%' THEN 'Boissons'
          WHEN question ILIKE '%huile%' OR question ILIKE '%corps gras%' THEN 'Huiles'
          WHEN question ILIKE '%pain%' OR question ILIKE '%boulangerie%' THEN 'Boulangerie'
          WHEN question ILIKE '%fruit%' OR question ILIKE '%légume%' THEN 'Fruits/Légumes'
          WHEN question ILIKE '%poisson%' OR question ILIKE '%aquaculture%' THEN 'Aquaculture'
          ELSE 'Général'
        END AS sector,
        COUNT(*)::int AS count
      FROM messages
      GROUP BY sector
      ORDER BY count DESC
    `;

    // Conversations complètes par utilisateur
    const result = [];
    for (const u of users) {
      const msgs = await sql`
        SELECT question, reponse, created_at, conversation_id
        FROM messages
        WHERE user_email = ${u.email}
        ORDER BY created_at DESC
        LIMIT 50
      `;
      result.push({
        email: u.email,
        name: u.name,
        isAdmin: u.is_admin,
        blocked: u.blocked || false,
        createdAt: u.created_at,
        messageCount: u.message_count,
        conversation: msgs
      });
    }

    return res.json({
      users: result,
      stats: {
        totalUsers: users.length,
        totalMessages: totalMessages[0]?.count || 0,
        todayMessages: todayMessages[0]?.count || 0,
        weekMessages: weekMessages[0]?.count || 0,
        blockedUsers: users.filter(u => u.blocked).length,
        adminUsers: users.filter(u => u.is_admin).length
      },
      topQuestions,
      activity,
      sectors
    });

  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
}
