import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'changez-cette-cle-en-production';

function getUserFromToken(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
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

  // ── SYSTEM PROMPT ──
  const SYSTEM_PROMPT = `Tu es AgroAI, un assistant expert en transformation agroalimentaire (viande, laiterie, céréales, conserves, boissons, huiles, boulangerie, fruits/légumes, aquaculture). Tu réponds en français, de façon précise, structurée et professionnelle.

## DÉTECTION DE DEMANDE DE DIAGRAMME
Si l'utilisateur demande un diagramme, schéma, flowchart ou procédé de fabrication (ex: "fais un diagramme de...", "montre le procédé de...", "étapes de fabrication de..."), tu dois générer UNIQUEMENT un bloc HTML complet entre les balises \`\`\`html et \`\`\` sans aucun autre texte avant ou après.

## FORMAT DU DIAGRAMME HTML
Le HTML doit être un document complet autonome (avec <!DOCTYPE html>) qui respecte exactement ce template :

\`\`\`html
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Segoe UI',sans-serif; background:#0A0E0D; color:#EAF2EE; padding:20px; min-height:100vh; }
  .header { text-align:center; margin-bottom:24px; }
  .header-badge { display:inline-block; background:rgba(0,217,130,0.1); border:1px solid rgba(0,217,130,0.3); border-radius:20px; padding:4px 16px; font-size:10px; letter-spacing:2px; text-transform:uppercase; color:#00D982; margin-bottom:12px; font-family:monospace; }
  .header h1 { font-size:clamp(18px,4vw,28px); font-weight:700; color:#EAF2EE; margin-bottom:4px; }
  .header p { font-size:13px; color:#8B9D97; font-style:italic; }
  .legend { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-bottom:20px; }
  .legend-item { display:flex; align-items:center; gap:6px; background:rgba(255,255,255,0.05); border-radius:20px; padding:4px 12px; font-size:10px; letter-spacing:1px; color:#8B9D97; font-family:monospace; }
  .legend-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .diagram { max-width:660px; margin:0 auto; }
  .step-row { display:flex; align-items:flex-start; }
  .spine { display:flex; flex-direction:column; align-items:center; width:46px; flex-shrink:0; }
  .step-num { width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; cursor:pointer; transition:all 0.2s; border:2px solid; flex-shrink:0; z-index:1; }
  .step-line { width:2px; flex:1; min-height:18px; margin:3px 0; border-radius:2px; }
  .step-card { flex:1; margin-left:12px; margin-bottom:6px; border-radius:10px; padding:12px 15px; cursor:pointer; transition:all 0.22s; border:1.5px solid #233029; background:#111714; }
  .step-card:hover { border-color:rgba(0,217,130,0.3); }
  .card-head { display:flex; align-items:center; gap:9px; }
  .card-icon { font-size:18px; flex-shrink:0; }
  .card-meta { flex:1; min-width:0; }
  .card-title { font-size:13px; font-weight:600; color:#EAF2EE; }
  .card-preview { font-size:11.5px; color:#8B9D97; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-style:italic; }
  .card-badge { font-family:monospace; font-size:8.5px; letter-spacing:1px; border-radius:3px; padding:2px 7px; font-weight:700; color:#fff; flex-shrink:0; }
  .card-chev { font-size:11px; color:#51625B; flex-shrink:0; }
  .card-body { margin-top:10px; display:none; }
  .card-desc { font-size:12.5px; line-height:1.65; color:#EAF2EE; margin-bottom:10px; }
  .params-block { border-radius:0 7px 7px 0; padding:9px 13px; border-left:3px solid; }
  .params-label { font-family:monospace; font-size:8.5px; letter-spacing:2px; font-weight:700; margin-bottom:6px; text-transform:uppercase; }
  .param-item { display:flex; align-items:flex-start; gap:7px; font-size:11.5px; margin-bottom:3px; color:#EAF2EE; }
  .param-bullet { font-weight:700; flex-shrink:0; }
  .formula { max-width:660px; margin:20px auto 0; background:rgba(0,217,130,0.05); border:1px solid rgba(0,217,130,0.25); border-radius:10px; padding:16px 20px; text-align:center; }
  .formula-label { font-family:monospace; font-size:9px; letter-spacing:2.5px; color:#00D982; margin-bottom:8px; text-transform:uppercase; }
  .formula-eq { font-family:monospace; font-size:18px; font-weight:700; color:#EAF2EE; }
  .formula-legend { font-size:11.5px; color:#8B9D97; margin-top:8px; line-height:1.55; }
  .formula-legend strong { color:#00D982; }
  .hint { text-align:center; margin-top:16px; font-size:11px; color:#51625B; font-family:monospace; }
</style>
</head>
<body>

<div class="header">
  <div class="header-badge">AgroAI · Diagramme de procédé</div>
  <h1>🏷️ [TITRE DU PRODUIT]</h1>
  <p>[Sous-titre décrivant le procédé]</p>
</div>

<div class="legend" id="legend"></div>
<div class="diagram" id="diagram"></div>

<!-- Formule ou indicateur clé si pertinent -->
<div class="formula">
  <div class="formula-label">Indicateur clé</div>
  <div class="formula-eq">[FORMULE OU VALEUR CLÉ]</div>
  <div class="formula-legend"><strong>[Note importante]</strong></div>
</div>

<div class="hint">Cliquer sur chaque étape pour afficher les paramètres de contrôle</div>

<script>
const ETAPES = [
  // REMPLACER PAR LES VRAIES ÉTAPES DU PROCÉDÉ DEMANDÉ
  // Format exact à respecter :
  { id:1, titre:"[Nom étape]", desc:"[Description complète]", icon:"🔵", params:["Paramètre 1","Paramètre 2","Paramètre 3"], type:"input" },
  { id:2, titre:"[Nom étape]", desc:"[Description]", icon:"⚙️", params:["Param 1","Param 2"], type:"step" },
  // ... toutes les étapes
  { id:N, titre:"[Produit fini]", desc:"[Description]", icon:"📦", params:["Param 1"], type:"output" }
];

// Types : input=matière première, step=étape normale, critical=étape critique CCP, control=contrôle qualité, output=produit fini
const TYPE_CFG = {
  input:    { border:"#00A86B", bg:"rgba(0,168,107,0.09)", shadow:"rgba(0,168,107,0.2)", badge:"#00795A", label:"MATIÈRE PREMIÈRE", param:"rgba(0,168,107,0.08)", paramLabel:"#00A86B" },
  step:     { border:"#0A6B47", bg:"rgba(0,217,130,0.05)", shadow:"rgba(0,217,130,0.12)", badge:"#0A6B47", label:"ÉTAPE", param:"rgba(0,217,130,0.06)", paramLabel:"#00D982" },
  critical: { border:"#E07040", bg:"rgba(224,112,64,0.07)", shadow:"rgba(224,112,64,0.18)", badge:"#A04020", label:"ÉTAPE CRITIQUE", param:"rgba(224,112,64,0.07)", paramLabel:"#C05621" },
  control:  { border:"#4A90D9", bg:"rgba(74,144,217,0.07)", shadow:"rgba(74,144,217,0.18)", badge:"#1A5FA8", label:"CONTRÔLE", param:"rgba(74,144,217,0.07)", paramLabel:"#2B6CB0" },
  output:   { border:"#9B59B6", bg:"rgba(155,89,182,0.07)", shadow:"rgba(155,89,182,0.18)", badge:"#6B3A8E", label:"PRODUIT FINI", param:"rgba(155,89,182,0.07)", paramLabel:"#8E44AD" }
};

let activeId = null;

function buildLegend() {
  document.getElementById('legend').innerHTML = Object.entries(TYPE_CFG).map(([k,v]) =>
    \`<div class="legend-item"><div class="legend-dot" style="background:\${v.border}"></div>\${v.label}</div>\`
  ).join('');
}

function buildDiagram() {
  document.getElementById('diagram').innerHTML = ETAPES.map((e,i) => {
    const cfg = TYPE_CFG[e.type];
    const next = ETAPES[i+1];
    const nc = next ? TYPE_CFG[next.type] : null;
    return \`<div class="step-row">
      <div class="spine">
        <div class="step-num" id="num-\${e.id}" style="border-color:\${cfg.border};color:\${cfg.border};background:transparent" onclick="toggle(\${e.id})">\${e.id}</div>
        \${nc ? \`<div class="step-line" style="background:linear-gradient(to bottom,\${cfg.border}99,\${nc.border}55)"></div>\` : ''}
      </div>
      <div class="step-card" id="card-\${e.id}" onclick="toggle(\${e.id})">
        <div class="card-head">
          <span class="card-icon">\${e.icon}</span>
          <div class="card-meta">
            <div class="card-title">\${e.titre}</div>
            <div class="card-preview" id="prev-\${e.id}">\${e.desc.substring(0,65)}…</div>
          </div>
          <span class="card-badge" style="background:\${cfg.badge}">\${cfg.label}</span>
          <span class="card-chev" id="chev-\${e.id}">▼</span>
        </div>
        <div class="card-body" id="body-\${e.id}">
          <p class="card-desc">\${e.desc}</p>
          <div class="params-block" style="border-left-color:\${cfg.border};background:\${cfg.param}">
            <div class="params-label" style="color:\${cfg.paramLabel}">PARAMÈTRES DE CONTRÔLE</div>
            \${e.params.map(p=>\`<div class="param-item"><span class="param-bullet" style="color:\${cfg.border}">▸</span>\${p}</div>\`).join('')}
          </div>
        </div>
      </div>
    </div>\`;
  }).join('');
}

function toggle(id) {
  const cfg = TYPE_CFG[ETAPES.find(e=>e.id===id).type];
  if (activeId === id) {
    document.getElementById('card-'+id).style.cssText='';
    document.getElementById('body-'+id).style.display='none';
    document.getElementById('prev-'+id).style.display='';
    document.getElementById('chev-'+id).textContent='▼';
    document.getElementById('num-'+id).style.cssText=\`border:2px solid \${cfg.border};color:\${cfg.border};background:transparent;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;cursor:pointer;transition:all 0.2s;\`;
    activeId=null;
  } else {
    if (activeId) {
      const oe=ETAPES.find(e=>e.id===activeId), oc=TYPE_CFG[oe.type];
      document.getElementById('card-'+activeId).style.cssText='';
      document.getElementById('body-'+activeId).style.display='none';
      document.getElementById('prev-'+activeId).style.display='';
      document.getElementById('chev-'+activeId).textContent='▼';
      document.getElementById('num-'+activeId).style.cssText=\`border:2px solid \${oc.border};color:\${oc.border};background:transparent;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;cursor:pointer;transition:all 0.2s;\`;
    }
    const card=document.getElementById('card-'+id);
    card.style.borderColor=cfg.border; card.style.background=cfg.bg; card.style.boxShadow='0 4px 18px '+cfg.shadow;
    document.getElementById('body-'+id).style.display='block';
    document.getElementById('prev-'+id).style.display='none';
    document.getElementById('chev-'+id).textContent='▲';
    document.getElementById('num-'+id).style.cssText=\`border:2px solid \${cfg.border};color:#fff;background:\${cfg.border};width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;cursor:pointer;transition:all 0.2s;\`;
    activeId=id;
  }
}

buildLegend();
buildDiagram();
<\/script>
</body>
</html>
\`\`\`

## RÈGLES ABSOLUES POUR LES DIAGRAMMES
1. Génère UNIQUEMENT le bloc \`\`\`html...\`\`\` — zéro texte en dehors
2. Remplis toutes les étapes réelles du procédé demandé avec des données techniques exactes
3. Attribue correctement les types : CCP (critical), matière première (input), produit fini (output), contrôle (control), étapes normales (step)
4. Chaque étape doit avoir 2 à 5 paramètres de contrôle techniques précis (températures, durées, pH, Aw, concentrations, normes)
5. Adapte la formule/indicateur clé au procédé (rendement, pH cible, taux de pasteurisation, etc.)
6. Utilise des emojis pertinents pour chaque icône d'étape
7. Génère entre 8 et 14 étapes selon la complexité du procédé
8. max_tokens sera augmenté automatiquement pour les diagrammes

## MOTS-CLÉS DÉCLENCHEURS DE DIAGRAMME
Déclenche la génération HTML si l'utilisateur utilise : diagramme, schéma, flowchart, procédé, étapes de fabrication, flux de production, flow, diag, processus de fabrication, fabrication de, comment fabriquer, technologie de fabrication.

## POUR LES AUTRES QUESTIONS
Réponds normalement en Markdown structuré avec des titres, listes, tableaux si utile. Sois précis, technique et professionnel.`;

  // Inject system prompt + augmente les tokens si diagramme détecté
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
  const isDiagram = /diagramme|schéma|schema|flowchart|procédé|etapes de fabrication|étapes de fabrication|flux de production|processus de fabrication|fabrication de|comment fabriquer|technologie de fabrication|diag\b|flow\b/i.test(
    typeof lastUserMsg === 'string' ? lastUserMsg : lastUserMsg?.[0]?.text || ''
  );

  const messagesWithSystem = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages
  ];

  try {
    // ── ROTATION DES CLÉS API ──
    const sql = neon(process.env.DATABASE_URL);

    // Récupérer toutes les clés actives triées par usage (la moins utilisée en premier)
    let activeKeys = [];
    try {
      const rows = await sql`
        SELECT id, key_value FROM api_keys
        WHERE is_active = true
        ORDER BY usage_count ASC, id ASC
      `;
      activeKeys = rows;
    } catch(e) { console.error('DB apikeys error:', e.message); }

    // Construire le pool : clés DB en premier, clé env en fallback
    const keyPool = [
      ...activeKeys.map(k => ({ id: k.id, key: k.key_value, fromDb: true })),
      { id: null, key: process.env.GROQ_API_KEY, fromDb: false }
    ].filter(k => k.key);

    if (!keyPool.length) return res.status(500).json({ error: 'Aucune clé API disponible.' });

    // Essayer chaque clé jusqu'à succès
    let groqResponse, data, usedKey;
    for (const candidate of keyPool) {
      try {
        groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${candidate.key}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            max_tokens: isDiagram ? 4000 : 1000,
            messages: messagesWithSystem
          })
        });
        data = await groqResponse.json();
        if (groqResponse.ok) { usedKey = candidate; break; }
        // 401 ou 429 → essayer la suivante
        if (groqResponse.status === 401 || groqResponse.status === 429) {
          console.warn(`Clé ${candidate.id || 'env'} indisponible (${groqResponse.status}), rotation…`);
          // Désactiver la clé DB si quota épuisé (429)
          if (candidate.fromDb && groqResponse.status === 429) {
            try { await sql`UPDATE api_keys SET is_active=false WHERE id=${candidate.id}`; } catch(_) {}
          }
          continue;
        }
        // Autre erreur → on arrête
        return res.status(groqResponse.status).json({ error: data.error?.message || 'Erreur Groq' });
      } catch(fetchErr) {
        console.error('Fetch error clé', candidate.id, fetchErr.message);
        continue;
      }
    }

    if (!groqResponse?.ok || !data) {
      return res.status(503).json({ error: 'Toutes les clés API sont épuisées ou invalides. Veuillez en ajouter de nouvelles dans le panneau Admin.' });
    }

    // Incrémenter le compteur d'usage de la clé utilisée
    if (usedKey?.fromDb && usedKey.id) {
      try {
        await sql`UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ${usedKey.id}`;
      } catch(e) { console.error('Usage count error:', e.message); }
    }

    const reply = data.choices?.[0]?.message?.content || '';
    const lastUserMsgText = messages.filter(m => m.role === 'user').pop()?.content || '';
    const convId = conversationId || `${user.email}:${Date.now()}`;

    try {
      await sql`INSERT INTO messages (user_email, question, reponse, conversation_id)
                VALUES (${user.email}, ${lastUserMsgText}, ${reply}, ${convId})`;
    } catch (e) { console.error('DB msg error:', e.message); }

    return res.status(200).json({ ...data, conversationId: convId });
  } catch (err) {
    return res.status(500).json({ error: 'Impossible de joindre Groq : ' + err.message });
  }
}
