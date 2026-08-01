import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

// Autorise la fonction à tourner jusqu'à 60s (max autorisé sur le plan Hobby) au lieu
// des 10s par défaut — nécessaire car les continuations automatiques (relances vers
// Groq quand une réponse est coupée) prennent du temps cumulé.
export const config = { maxDuration: 60 };

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET manquant : définis cette variable d\'environnement avant de démarrer l\'application.');
}
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

// ── RECHERCHE WEB (Tavily) ──
// Retourne { contextText, sources } ou null si la recherche échoue / n'est pas configurée.
// contextText est injecté dans le prompt système ; sources est renvoyé au frontend
// pour afficher des liens cliquables sous la réponse.
async function performWebSearch(query) {
  if (!TAVILY_API_KEY || !query) return null;
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: false
      })
    });
    if (!r.ok) { console.error('Tavily error', r.status, await r.text().catch(()=>'')); return null; }
    const data = await r.json();
    const results = Array.isArray(data.results) ? data.results.slice(0, 5) : [];
    if (!results.length) return null;

    const sources = results.map((res, i) => ({
      index: i + 1,
      title: res.title || res.url,
      url: res.url,
      snippet: (res.content || '').slice(0, 300)
    }));

    const contextText = sources
      .map(s => `[${s.index}] ${s.title}\nURL : ${s.url}\nExtrait : ${s.snippet}`)
      .join('\n\n');

    return { contextText, sources };
  } catch (e) {
    console.error('Web search error:', e.message);
    return null;
  }
}

// Détection automatique d'un besoin probable de recherche web (info datée / récente / réglementaire)
function looksLikeItNeedsWebSearch(text) {
  if (typeof text !== 'string') return false;
  return /actualit[ée]|r[ée]cent|derni[eè]re?s?\b|aujourd'hui|cette semaine|ce mois|en 20\d{2}|nouvelle (norme|r[ée]glementation|loi)|prix (actuel|du march[ée])|cours du (jour|march[ée])|derni[eè]re version|mise[s]? à jour r[ée]cente/i.test(text);
}

// Modèle Groq utilisé pour toutes les requêtes.
// llama-3.3-70b-versatile a été déprécié par Groq — remplacé par
// openai/gpt-oss-120b (le plus solide actuellement pour suivre des
// instructions structurées comme la génération de diagrammes HTML).
const GROQ_MODEL = 'openai/gpt-oss-120b';

function getUserFromToken(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Extrait les en-têtes de quota renvoyés par Groq (mêmes en-têtes que l'API OpenAI)
function extractRateLimitInfo(headers) {
  const num = (v) => (v == null ? null : Number(v));
  return {
    limitRequests: num(headers.get('x-ratelimit-limit-requests')),
    remainingRequests: num(headers.get('x-ratelimit-remaining-requests')),
    resetRequests: headers.get('x-ratelimit-reset-requests') || null,
    limitTokens: num(headers.get('x-ratelimit-limit-tokens')),
    remainingTokens: num(headers.get('x-ratelimit-remaining-tokens')),
    resetTokens: headers.get('x-ratelimit-reset-tokens') || null
  };
}

async function saveRateLimitInfo(sql, keyId, info) {
  if (!keyId) return;
  try {
    await sql`
      UPDATE api_keys SET
        rl_limit_requests = ${info.limitRequests},
        rl_remaining_requests = ${info.remainingRequests},
        rl_reset_requests = ${info.resetRequests},
        rl_limit_tokens = ${info.limitTokens},
        rl_remaining_tokens = ${info.remainingTokens},
        rl_reset_tokens = ${info.resetTokens},
        rl_updated_at = NOW()
      WHERE id = ${keyId}
    `;
    await maybeAlertLowQuota(sql, keyId, info);
  } catch (e) { console.error('Rate limit save error:', e.message); }
}

// Seuil d'alerte : moins de 10% du quota restant (requêtes ou tokens)
const LOW_QUOTA_THRESHOLD = 0.10;
const ALERT_COOLDOWN_HOURS = 6;

async function maybeAlertLowQuota(sql, keyId, info) {
  try {
    const reqPct = info.limitRequests ? info.remainingRequests / info.limitRequests : null;
    const tokPct = info.limitTokens ? info.remainingTokens / info.limitTokens : null;
    const isLow = (reqPct !== null && reqPct <= LOW_QUOTA_THRESHOLD) || (tokPct !== null && tokPct <= LOW_QUOTA_THRESHOLD);
    if (!isLow) return;

    const keyRows = await sql`SELECT label FROM api_keys WHERE id = ${keyId}`;
    const label = keyRows[0]?.label || `Clé #${keyId}`;

    await sql`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    // Anti-spam : pas plus d'une alerte par clé toutes les ALERT_COOLDOWN_HOURS
    const cooldownStart = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 3600000).toISOString();
    const recent = await sql`
      SELECT id FROM notifications
      WHERE type = 'alert' AND title LIKE ${'%' + label + '%'} AND created_at >= ${cooldownStart}
      LIMIT 1
    `;
    if (recent.length > 0) return;

    const pctDisplay = Math.round(Math.min(reqPct ?? 1, tokPct ?? 1) * 100);
    await sql`
      INSERT INTO notifications (type, title, body, created_by)
      VALUES ('alert', ${'⚠️ Quota Groq faible — ' + label},
              ${`Il ne reste plus qu'environ ${pctDisplay}% du quota (requêtes/tokens) pour la clé "${label}". Pense à en ajouter une nouvelle ou à vérifier la rotation.`},
              'system')
    `;
  } catch (e) { console.error('Low quota alert error:', e.message); }
}

// ── Limite la taille de l'historique envoyé à Groq ──
// Garde le message système (toujours en premier) + les N derniers messages
// user/assistant. Évite que l'historique complet fasse dépasser le quota
// TPM de l'organisation au fil d'une longue conversation.
const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_MESSAGES_HEAVY = 4; // pour diagrammes/documents : max_tokens élevé, donc historique réduit davantage
function trimHistory(msgs, limit = MAX_HISTORY_MESSAGES) {
  if (!Array.isArray(msgs) || msgs.length <= limit + 1) return msgs;
  const hasSystem = msgs[0]?.role === 'system';
  const systemMsg = hasSystem ? [msgs[0]] : [];
  const rest = hasSystem ? msgs.slice(1) : msgs;
  return [...systemMsg, ...rest.slice(-limit)];
}

// Un flux SSE Groq est coupé net si le nombre de ``` est impair (bloc de code / diagramme non refermé)
function isUnclosedFence(s) {
  return ((s.match(/```/g) || []).length % 2) === 1;
}

// ── Lit un flux SSE (format OpenAI-compatible) renvoyé par Groq et appelle onDelta(text)
// pour chaque fragment de contenu reçu. Retourne le finish_reason final ('stop', 'length', ...).
async function pumpGroqStream(groqResponse, onDelta) {
  const reader = groqResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() || ''; // dernier fragment potentiellement incomplet, on le garde pour la suite

    for (const part of parts) {
      const line = part.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) onDelta(delta);
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
    }
  }
  return finishReason;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Connexion requise.' });

  const { messages, conversationId } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages manquant' });

  const sql = neon(process.env.DATABASE_URL);

  // Migration idempotente : ajoute les colonnes de suivi de quota si elles n'existent pas encore
  try {
    await sql`
      ALTER TABLE api_keys
      ADD COLUMN IF NOT EXISTS rl_limit_requests INTEGER,
      ADD COLUMN IF NOT EXISTS rl_remaining_requests INTEGER,
      ADD COLUMN IF NOT EXISTS rl_reset_requests TEXT,
      ADD COLUMN IF NOT EXISTS rl_limit_tokens INTEGER,
      ADD COLUMN IF NOT EXISTS rl_remaining_tokens INTEGER,
      ADD COLUMN IF NOT EXISTS rl_reset_tokens TEXT,
      ADD COLUMN IF NOT EXISTS rl_updated_at TIMESTAMPTZ
    `;
  } catch (e) { console.error('Migration api_keys error:', e.message); }

  // ── Injection des instructions IA personnalisées de l'admin ──
  // Génération de document (PDF/Word/Excel/PowerPoint) : conversation technique,
  // ne doit ni recevoir les consignes admin (JSON strict requis) ni être enregistrée.
  const isDocGen = typeof conversationId === 'string' && conversationId.startsWith('doc-gen-');
  if (!isDocGen) {
    try {
      const cfgRows = await sql`SELECT value FROM system_config WHERE key = 'ai_extra_instructions'`;
      const extraInstructions = (cfgRows[0]?.value || '').trim();
      if (extraInstructions && messages[0]?.role === 'system') {
        messages[0].content = `${messages[0].content}\n\nCONSIGNES SUPPLÉMENTAIRES DE L'ADMINISTRATEUR (priorité haute, à toujours respecter) :\n${extraInstructions}`;
      }
    } catch(e) { console.error('system_config error:', e.message); }
  }

  // ── DÉTECTION DE DEMANDE DE DIAGRAMME ──
  // Le PROMPT SYSTÈME (avec les instructions complètes de génération de
  // diagrammes au format 'html-diagram' + classes .dg-*) est déjà envoyé
  // par le front-end en premier message du tableau `messages`.
  // On ne le duplique plus ici pour éviter d'envoyer deux prompts système
  // contradictoires à Groq — ce backend se contente de détecter la demande
  // de diagramme pour augmenter le budget de tokens en conséquence.
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
  const isDiagram = /diagramme|schéma|schema|flowchart|procédé|etapes de fabrication|étapes de fabrication|flux de production|processus de fabrication|fabrication de|comment fabriquer|technologie de fabrication|diag\b|flow\b/i.test(
    typeof lastUserMsg === 'string' ? lastUserMsg : lastUserMsg?.[0]?.text || ''
  );
  // Génération de document (PDF/Word/Excel/PowerPoint) : réponse JSON potentiellement longue
  let maxTokens = isDocGen ? 6000 : (isDiagram ? 5000 : 2000);

  // ── RECHERCHE WEB ──
  // Déclenchée soit explicitement par le frontend (bouton "Recherche web" activé),
  // soit automatiquement si la question sent le besoin d'une info récente/datée.
  let webSources = null;
  if (!isDocGen) {
    const wantsWebSearch = req.body.webSearch === true || looksLikeItNeedsWebSearch(
      typeof lastUserMsg === 'string' ? lastUserMsg : (lastUserMsg?.[0]?.text || '')
    );
    if (wantsWebSearch) {
      const searchResult = await performWebSearch(
        typeof lastUserMsg === 'string' ? lastUserMsg : (lastUserMsg?.[0]?.text || '')
      );
      if (searchResult && messages[0]?.role === 'system') {
        messages[0].content = `${messages[0].content}\n\nRÉSULTATS DE RECHERCHE WEB (utilise-les pour répondre, cite tes sources avec [1], [2]... et n'invente aucune information qui ne s'y trouve pas si la question porte sur une donnée récente/datée) :\n\n${searchResult.contextText}`;
        webSources = searchResult.sources;
        maxTokens = Math.max(maxTokens, 3000);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  BRANCHE 1 : GÉNÉRATION DE DOCUMENT (JSON structuré, pas de streaming)
  //  Inchangée — l'export PDF/Word/Excel/PPTX a besoin d'un JSON complet
  //  et valide, pas de fragments.
  // ══════════════════════════════════════════════════════════════
  if (isDocGen) {
    try {
      let activeKeys = [];
      try {
        const rows = await sql`
          SELECT id, key_value FROM api_keys
          WHERE is_active = true AND provider = 'groq'
          ORDER BY usage_count ASC, id ASC
        `;
        activeKeys = rows;
      } catch(e) { console.error('DB apikeys error:', e.message); }

      const keyPool = [
        ...activeKeys.map(k => ({ id: k.id, key: k.key_value, fromDb: true })),
        { id: null, key: process.env.GROQ_API_KEY, fromDb: false }
      ].filter(k => k.key);

      if (!keyPool.length) return res.status(500).json({ error: 'Aucune clé API disponible.' });

      const docMessages = trimHistory(messages, MAX_HISTORY_MESSAGES_HEAVY);
      let groqResponse, data, usedKey;
      for (const candidate of keyPool) {
        try {
          groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${candidate.key}` },
            body: JSON.stringify({
              model: GROQ_MODEL,
              max_tokens: maxTokens,
              temperature: 0.6,
              messages: docMessages
            })
          });
          data = await groqResponse.json();

          if (candidate.fromDb) {
            const rlInfo = extractRateLimitInfo(groqResponse.headers);
            if (rlInfo.limitRequests !== null || rlInfo.limitTokens !== null) {
              await saveRateLimitInfo(sql, candidate.id, rlInfo);
            }
          }

          if (groqResponse.ok) { usedKey = candidate; break; }
          if (groqResponse.status === 401 || groqResponse.status === 429) {
            console.warn(`Clé ${candidate.id || 'env'} indisponible (${groqResponse.status}), rotation…`);
            if (candidate.fromDb) {
              try {
                if (groqResponse.status === 401) {
                  await sql`UPDATE api_keys SET is_active=false, error_count=error_count+1 WHERE id=${candidate.id}`;
                } else {
                  await sql`UPDATE api_keys SET error_count=error_count+1 WHERE id=${candidate.id}`;
                }
              } catch(_) {}
            }
            continue;
          }
          return res.status(groqResponse.status).json({ error: data.error?.message || 'Erreur Groq' });
        } catch(fetchErr) {
          console.error('Fetch error clé', candidate.id, fetchErr.message);
          continue;
        }
      }

      if (!groqResponse?.ok || !data) {
        return res.status(503).json({ error: 'Toutes les clés API sont épuisées ou invalides. Veuillez en ajouter de nouvelles dans le panneau Admin.' });
      }

      if (usedKey?.fromDb && usedKey.id) {
        try {
          await sql`UPDATE api_keys SET usage_count = usage_count + 1, error_count = 0, last_used_at = NOW() WHERE id = ${usedKey.id}`;
        } catch(e) { console.error('Usage count error:', e.message); }
      }

      // ── Continuation si le JSON a été coupé net par la limite de tokens ──
      // (essentiel ici : un JSON tronqué est invalide et casse l'export du document)
      let reply = data.choices?.[0]?.message?.content || '';
      let finishReason = data.choices?.[0]?.finish_reason || null;
      let docContinuations = 0;
      while (finishReason === 'length' && docContinuations < 4) {
        docContinuations++;
        try {
          const contMessages = [
            ...docMessages,
            { role: 'assistant', content: reply },
            { role: 'user', content: "Continue exactement là où tu t'es arrêté, sans rien répéter, jusqu'à obtenir un JSON complet et valide." }
          ];
          const contResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${usedKey.key}` },
            body: JSON.stringify({ model: GROQ_MODEL, max_tokens: maxTokens, temperature: 0.6, messages: contMessages })
          });
          const contData = await contResp.json().catch(() => null);
          if (!contResp.ok || !contData) break;
          reply += contData.choices?.[0]?.message?.content || '';
          finishReason = contData.choices?.[0]?.finish_reason || null;
        } catch (contErr) {
          console.error('Doc continuation error:', contErr.message);
          break;
        }
      }

      const convId = conversationId || `${user.email}:${Date.now()}`;

      return res.status(200).json({ ...data, choices: [{ ...data.choices?.[0], message: { ...data.choices?.[0]?.message, content: reply } }], conversationId: convId, sources: webSources || undefined });
    } catch (err) {
      return res.status(500).json({ error: 'Impossible de joindre Groq : ' + err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  BRANCHE 2 : CHAT NORMAL — STREAMING SSE EN TEMPS RÉEL
  // ══════════════════════════════════════════════════════════════
  try {
    // ── Contrôle utilisateur pendant la génération (bouton Stop côté frontend) ──
    // Si le client ferme la connexion avant la fin normale (res.end()), on coupe
    // aussitôt l'appel Groq en cours : ça évite de consommer du quota pour du
    // texte que plus personne ne regarde, et on saute la continuation auto.
    const groqAbortController = new AbortController();
    let clientDisconnected = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        try { groqAbortController.abort(); } catch(_) {}
      }
    });

    let activeKeys = [];
    try {
      const rows = await sql`
        SELECT id, key_value FROM api_keys
        WHERE is_active = true AND provider = 'groq'
        ORDER BY usage_count ASC, id ASC
      `;
      activeKeys = rows;
    } catch(e) { console.error('DB apikeys error:', e.message); }

    const keyPool = [
      ...activeKeys.map(k => ({ id: k.id, key: k.key_value, fromDb: true })),
      { id: null, key: process.env.GROQ_API_KEY, fromDb: false }
    ].filter(k => k.key);

    if (!keyPool.length) return res.status(500).json({ error: 'Aucune clé API disponible.' });

    // ── Essayer chaque clé jusqu'à obtenir un flux valide (headers reçus, pas encore de contenu lu) ──
    let usedKey = null;
    let firstGroqResponse = null;
    const trimmedMessages = trimHistory(messages, isDiagram ? MAX_HISTORY_MESSAGES_HEAVY : MAX_HISTORY_MESSAGES);

    for (const candidate of keyPool) {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${candidate.key}` },
          body: JSON.stringify({
            model: GROQ_MODEL,
            max_tokens: maxTokens,
            temperature: 0.6,
            stream: true,
            messages: trimmedMessages
          }),
          signal: groqAbortController.signal
        });

        if (candidate.fromDb) {
          const rlInfo = extractRateLimitInfo(r.headers);
          if (rlInfo.limitRequests !== null || rlInfo.limitTokens !== null) {
            await saveRateLimitInfo(sql, candidate.id, rlInfo);
          }
        }

        if (r.ok) { usedKey = candidate; firstGroqResponse = r; break; }

        // Erreur → le corps est du JSON classique (pas du SSE) même en mode stream
        const errBody = await r.json().catch(() => ({}));

        if (r.status === 401 || r.status === 429) {
          console.warn(`Clé ${candidate.id || 'env'} indisponible (${r.status}), rotation…`);
          if (candidate.fromDb) {
            try {
              if (r.status === 401) {
                await sql`UPDATE api_keys SET is_active=false, error_count=error_count+1 WHERE id=${candidate.id}`;
              } else {
                await sql`UPDATE api_keys SET error_count=error_count+1 WHERE id=${candidate.id}`;
              }
            } catch(_) {}
          }
          continue;
        }
        return res.status(r.status).json({ error: errBody.error?.message || 'Erreur Groq' });
      } catch (fetchErr) {
        console.error('Fetch error clé', candidate.id, fetchErr.message);
        continue;
      }
    }

    if (!usedKey || !firstGroqResponse) {
      return res.status(503).json({ error: 'Toutes les clés API sont épuisées ou invalides. Veuillez en ajouter de nouvelles dans le panneau Admin.' });
    }

    if (usedKey.fromDb && usedKey.id) {
      try {
        await sql`UPDATE api_keys SET usage_count = usage_count + 1, error_count = 0, last_used_at = NOW() WHERE id = ${usedKey.id}`;
      } catch(e) { console.error('Usage count error:', e.message); }
    }

    // ── À partir d'ici on s'engage sur du SSE : les en-têtes partent tout de suite ──
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch(_) {} };

    if (webSources) send({ type: 'sources', sources: webSources });

    let fullReply = '';
    const onDelta = (delta) => { fullReply += delta; send({ type: 'delta', content: delta }); };

    let finishReason = null;
    try {
      finishReason = await pumpGroqStream(firstGroqResponse, onDelta);
    } catch (e) {
      console.error('Stream read error:', e.message);
    }

    // ── Continuation automatique si la réponse a été coupée par l'API ──
    // (limite de tokens atteinte en plein milieu d'un diagramme/tableau/liste).
    // Transparent pour le frontend : il reçoit juste plus d'événements 'delta'.
    let continuations = 0;
    const maxContinuations = isDiagram ? 5 : 3;
    while (!clientDisconnected && continuations < maxContinuations && (finishReason === 'length' || isUnclosedFence(fullReply))) {
      continuations++;
      try {
        const contMessages = [
          ...trimmedMessages,
          { role: 'assistant', content: fullReply },
          { role: 'user', content: "Continue exactement là où tu t'es arrêté, sans rien répéter et sans réintroduire de balises déjà ouvertes (poursuis directement le HTML/texte en cours)." }
        ];
        const contResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${usedKey.key}` },
          body: JSON.stringify({ model: GROQ_MODEL, max_tokens: maxTokens, temperature: 0.6, stream: true, messages: contMessages }),
          signal: groqAbortController.signal
        });
        if (!contResp.ok) break;
        finishReason = await pumpGroqStream(contResp, onDelta);
      } catch (contErr) {
        console.error('Continuation error:', contErr.message);
        break; // on garde ce qu'on a déjà plutôt que de bloquer l'affichage
      }
    }

    // ── Sauvegarde en base ──
    const lastUserMsgText = messages.filter(m => m.role === 'user').pop()?.content || '';
    const isPrivateAdminChat = typeof conversationId === 'string' && conversationId.startsWith('admin-priv-');
    const convId = conversationId || `${user.email}:${Date.now()}`;

    if (!isPrivateAdminChat) {
      try {
        await sql`INSERT INTO messages (user_email, question, reponse, conversation_id)
                  VALUES (${user.email}, ${typeof lastUserMsgText === 'string' ? lastUserMsgText : JSON.stringify(lastUserMsgText)}, ${fullReply}, ${convId})`;
      } catch (e) { console.error('DB msg error:', e.message); }
    }

    send({ type: 'done', conversationId: convId });
    return res.end();
  } catch (err) {
    // Si les en-têtes SSE sont déjà partis, impossible de renvoyer du JSON —
    // on notifie via un évènement 'error' dans le flux, sinon réponse JSON classique.
    if (res.headersSent) {
      try { res.write(`data: ${JSON.stringify({ type: 'error', error: 'Impossible de joindre Groq : ' + err.message })}\n\n`); } catch(_) {}
      return res.end();
    }
    return res.status(500).json({ error: 'Impossible de joindre Groq : ' + err.message });
  }
}
