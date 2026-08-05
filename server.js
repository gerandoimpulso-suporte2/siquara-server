require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ── Variáveis de ambiente ─────────────────────────────────────────────────────
const getEnv = (names, fallback = '') => {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return fallback;
};

const getToken        = () => getEnv(['META_ACCESS_TOKEN', 'ACCESS_TOKEN']);
const getAccountId    = () => getEnv(['META_AD_ACCOUNT_ID', 'AD_ACCOUNT_ID']);
const getIgId         = () => getEnv(['INSTAGRAM_ACCOUNT_ID', 'IG_ACCOUNT_ID', 'ID_DA_CONTA_DO_INSTAGRAM', 'INSTAGRAM_ID']);
const getDaysBack     = () => parseInt(getEnv(['DAYS_BACK', 'DIAS_ATRÁS', 'DIAS_ATRAS'], '7'), 10);
const getApiSecret    = () => getEnv(['API_SECRET'], 'siquara2025');
const getAnthropicKey = () => getEnv(['ANTHROPIC_API_KEY', 'ANTROPIC_API_KEY']);

// Railway Volume em /data; fallback para dados/ local no dev
const DADOS_DIR      = process.env.RAILWAY_ENVIRONMENT ? '/data' : path.join(__dirname, 'dados');
const DADOS_PATH     = path.join(DADOS_DIR, 'dados.json');
const DASHBOARD_PATH = path.join(__dirname, 'dashboard', 'dashboard.html');

if (!fs.existsSync(DADOS_DIR)) {
  fs.mkdirSync(DADOS_DIR, { recursive: true });
}

// dados.json = cache do último período buscado manualmente (15d, 30d, etc.)
// dados_24h.json / dados_7d.json = caches fixos, sempre atualizados pelo cron
// e pelas execuções desses períodos específicos, independentes um do outro.
function dadosPathFor(daysBack) {
  if (daysBack === 1) return path.join(DADOS_DIR, 'dados_24h.json');
  if (daysBack === 7) return path.join(DADOS_DIR, 'dados_7d.json');
  return DADOS_PATH;
}

// ── Autenticação ──────────────────────────────────────────────────────────────
const USERS = {
  'siquara': 'siquara@2025',
  'gerando': 'impulso@2025',
  'admin':   'admin123',
  'flavia':  'flavia@2025',
};

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie || '';
  rc.split(';').forEach(c => {
    const [k, ...v] = c.split('=');
    if (k) list[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return list;
}

function signToken(username) {
  const ts = Date.now();
  const sig = crypto.createHmac('sha256', getApiSecret())
    .update(`${username}:${ts}`).digest('hex');
  return `${Buffer.from(username).toString('base64url')}.${sig}.${ts}`;
}

function verifyToken(token) {
  try {
    const [b64, sig, tsStr] = (token || '').split('.');
    if (!b64 || !sig || !tsStr) return null;
    const username = Buffer.from(b64, 'base64url').toString();
    const ts = parseInt(tsStr, 10);
    if (Date.now() - ts > 8 * 60 * 60 * 1000) return null; // 8h TTL
    const expected = crypto.createHmac('sha256', getApiSecret())
      .update(`${username}:${ts}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return username;
  } catch {
    return null;
  }
}

function setCookie(res, req, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `siquara_auth=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}`);
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const user = verifyToken(cookies.siquara_auth);
  if (!user) return res.redirect('/?expired=1');
  req.user = user;
  next();
}

// ── Meta API helpers ──────────────────────────────────────────────────────────
async function metaGet(url, params) {
  return axios.get(url, {
    params,
    headers: { 'User-Agent': 'siquara-server/1.0', 'Accept': 'application/json' },
    timeout: 30000,
  });
}

async function fetchCampaigns(token, accountId) {
  const fields = 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time';
  const endpoints = [
    (v) => `https://graph.facebook.com/${v}/me/adaccounts/${accountId}/campaigns`,
    (v) => `https://graph.facebook.com/${v}/${accountId}/campaigns`,
  ];
  const errors = [];
  for (const make of endpoints) {
    for (const v of ['v19.0', 'v18.0', 'v17.0']) {
      const url = make(v);
      try {
        const r = await metaGet(url, { access_token: token, fields, limit: 100 });
        if (r.data?.data) return { success: true, data: r.data.data, endpoint: url };
      } catch (e) {
        errors.push({ url, code: e.response?.data?.error?.code, msg: e.response?.data?.error?.message || e.message });
      }
    }
  }
  return { success: false, errors };
}

// Para daysBack=1 (últimas 24h) usamos date_preset:'today' — a API de insights
// da Meta trabalha em granularidade de dia, não aceita time_range por hora.
function periodoParams(daysBack) {
  if (daysBack === 1) return { date_preset: 'today' };
  const end = new Date(), start = new Date();
  start.setDate(end.getDate() - daysBack);
  const fmt = d => d.toISOString().split('T')[0];
  return { time_range: JSON.stringify({ since: fmt(start), until: fmt(end) }) };
}

async function fetchInsights(token, accountId, daysBack) {
  const fields = [
    'campaign_name','campaign_id','adset_name','impressions','clicks','spend',
    'reach','cpc','cpm','ctr','frequency','actions','cost_per_action_type',
    'date_start','date_stop',
  ].join(',');
  const errors = [];
  for (const v of ['v19.0', 'v18.0']) {
    const url = `https://graph.facebook.com/${v}/${accountId}/insights`;
    try {
      const r = await metaGet(url, {
        access_token: token, fields,
        ...periodoParams(daysBack),
        level: 'campaign', limit: 200,
      });
      if (r.data?.data) return { success: true, data: r.data.data, endpoint: url };
    } catch (e) {
      errors.push({ url, code: e.response?.data?.error?.code, msg: e.response?.data?.error?.message || e.message });
    }
  }
  return { success: false, errors };
}

// Campos de mídia Instagram — sem since/until (não suportado pela API)
const IG_MEDIA_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink,video_views';

async function igMediaFetch(token, igId, limit = 50) {
  // Tenta diferentes versões e campos, sem filtro de data
  const versions = ['v19.0', 'v18.0', 'v17.0'];
  const erros = [];
  for (const v of versions) {
    try {
      const r = await metaGet(`https://graph.facebook.com/${v}/${igId}/media`, {
        access_token: token,
        fields: IG_MEDIA_FIELDS,
        limit,
      });
      const posts = r.data?.data || [];
      console.log(`[ORGANICO] media OK (${v}): ${posts.length} posts`);
      return { posts, version: v };
    } catch (e) {
      const code = e.response?.data?.error?.code;
      const msg  = e.response?.data?.error?.message || e.message;
      console.warn(`[ORGANICO] media ${v} erro ${code}: ${msg}`);
      erros.push({ version: v, code, msg });
    }
  }
  return { posts: [], erros };
}

async function fetchPostInsights(token, postId) {
  try {
    const r = await metaGet(`https://graph.facebook.com/v19.0/${postId}/insights`, {
      access_token: token,
      metric: 'reach,saved,shares',
    });
    const result = {};
    for (const item of (r.data?.data || [])) result[item.name] = item.values?.[0]?.value ?? item.value;
    return result;
  } catch { return {}; }
}

async function fetchOrganico(token, igId, daysBack = 30) {
  console.log(`[ORGANICO] igId="${igId}" daysBack=${daysBack} token="${token?.slice(0,20)}..."`);

  // 1. Buscar conta (funciona com token de Marketing API)
  let account;
  try {
    const r = await metaGet(`https://graph.facebook.com/v19.0/${igId}`, {
      access_token: token,
      fields: 'id,name,username,followers_count,follows_count,media_count,biography',
    });
    account = r.data;
    console.log(`[ORGANICO] Conta OK: @${account.username} (${account.followers_count} seguidores)`);
  } catch (e) {
    const code = e.response?.data?.error?.code;
    const msg  = e.response?.data?.error?.message || e.message;
    console.error(`[ORGANICO] conta erro ${code}: ${msg}`);
    return { success: false, errors: [{ code, msg }] };
  }

  // 2. Buscar posts SEM filtro de data (API IG não suporta since/until em /media)
  const { posts: allPosts, version: mediaVersion, erros: mediaErros } = await igMediaFetch(token, igId, 50);

  // Erro 10 = falta permissão instagram_basic — retorna conta + instrução clara
  const permissionError = mediaErros?.find(e => e.code === 10);
  if (allPosts.length === 0 && permissionError) {
    console.warn('[ORGANICO] Sem permissão instagram_basic para /media');

    // Extrai dados orgânicos que já temos nos insights de ads
    let igAdsData = [];
    if (fs.existsSync(DADOS_PATH)) {
      try {
        const d = JSON.parse(fs.readFileSync(DADOS_PATH, 'utf-8'));
        igAdsData = (d.insights || []).filter(i =>
          (i.publisher_platform || '').toLowerCase().includes('instagram') ||
          (i.adset_name || '').toLowerCase().includes('ig') ||
          (i.campaign_name || '').toLowerCase().includes('ig')
        );
      } catch {}
    }

    return {
      success: true,
      account,
      media: [],
      permission_error: {
        code: 10,
        descricao: 'O token atual (Marketing API) não tem permissão "instagram_basic" para ler posts do Instagram.',
        como_resolver: [
          '1. Acesse developers.facebook.com/tools/explorer',
          '2. Selecione seu App > adicione a permissão "instagram_basic"',
          '3. Clique em "Gerar Token de Acesso"',
          '4. Cole o novo token via POST /api/token com {"token": "novo_token"}',
        ],
      },
      ig_ads_data: igAdsData,
      meta: { media_erros: mediaErros },
    };
  }

  // 3. Filtrar por data no código
  const desde = new Date();
  desde.setDate(desde.getDate() - daysBack);
  const media = allPosts.filter(p => !p.timestamp || new Date(p.timestamp) >= desde);
  console.log(`[ORGANICO] ${allPosts.length} posts total → ${media.length} nos últimos ${daysBack} dias`);

  // 4. Buscar insights dos primeiros 12 posts
  const mediaComInsights = await Promise.all(
    media.slice(0, 12).map(async (post) => {
      const insights = await fetchPostInsights(token, post.id);
      return { ...post, insights };
    })
  );

  return {
    success: true,
    account,
    media: [...mediaComInsights, ...media.slice(12)],
    meta: { total_posts_api: allPosts.length, posts_no_periodo: media.length, days_back: daysBack, media_version: mediaVersion },
  };
}

async function validateToken(token, accountId) {
  try {
    const r = await metaGet(`https://graph.facebook.com/v19.0/${accountId}`, {
      access_token: token,
      fields: 'id,name,account_status,currency,timezone_name',
    });
    return { valid: true, account: r.data };
  } catch (e) {
    return { valid: false, error: e.response?.data?.error || { message: e.message } };
  }
}

// ── Página de Login ───────────────────────────────────────────────────────────
const LOGIN_PAGE = (err = '', expired = false) => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Siquara Analytics — Login</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@700;800&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:#F8F9FC;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#FFFFFF;border-radius:18px;padding:48px 40px;width:100%;max-width:400px;border:1px solid #E4E7F0;box-shadow:0 8px 32px rgb(0 0 0 / 0.08)}
    .logo{text-align:center;margin-bottom:32px}
    .logo-icon{width:56px;height:56px;border-radius:14px;background:#4F6AF0;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;font-family:'Plus Jakarta Sans',sans-serif;font-size:1.2rem;font-weight:700;color:#fff;letter-spacing:.02em}
    .logo h1{font-family:'Plus Jakarta Sans',sans-serif;color:#111827;font-size:1.4rem;font-weight:700}
    .logo p{color:#6B7280;font-size:.85rem;margin-top:4px}
    label{display:block;font-size:.75rem;font-weight:600;color:#374151;margin-bottom:6px;margin-top:20px;text-transform:uppercase;letter-spacing:.05em}
    input{width:100%;padding:12px 16px;background:#FFFFFF;border:1.5px solid #D0D5E8;border-radius:10px;color:#111827;font-size:.95rem;transition:border-color .2s,box-shadow .2s}
    input:focus{outline:none;border-color:#4F6AF0;box-shadow:0 0 0 3px #e0eaff}
    .btn{display:block;width:100%;margin-top:28px;padding:14px;background:#4F6AF0;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;transition:background .2s;letter-spacing:.03em}
    .btn:hover{background:#3d54d4}
    .err{background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:10px 14px;color:#DC2626;font-size:.82rem;margin-top:16px;text-align:center}
    .expired{background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:10px 14px;color:#C2410C;font-size:.82rem;margin-top:16px;text-align:center}
    .footer{text-align:center;margin-top:24px;color:#9CA3AF;font-size:.75rem}
    @media (max-width:480px){ input{font-size:16px} }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <span class="logo-icon">SM</span>
      <h1>Siquara Analytics</h1>
      <p>Siquara Mattos — Meta Ads</p>
    </div>
    <form method="POST" action="/login">
      <label for="u">Usuário</label>
      <input id="u" name="username" type="text" autocomplete="username" required autofocus placeholder="seu usuário">
      <label for="p">Senha</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required placeholder="••••••••">
      <button class="btn" type="submit">Entrar</button>
    </form>
    ${err     ? `<div class="err">Usuário ou senha incorretos.</div>` : ''}
    ${expired ? `<div class="expired">Sessão expirada. Faça login novamente.</div>` : ''}
    <div class="footer">Siquara Analytics v1.0</div>
  </div>
</body>
</html>`;

// ── Rotas públicas ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const cookies = parseCookies(req);
  if (verifyToken(cookies.siquara_auth)) return res.redirect('/dashboard');
  const { error, expired } = req.query;
  res.send(LOGIN_PAGE(error === '1', expired === '1'));
});

app.post('/login', (req, res) => {
  const { username = '', password = '' } = req.body;
  const expected = USERS[username.trim()];
  if (!expected || expected !== password) {
    return res.redirect('/?error=1');
  }
  const token = signToken(username.trim());
  setCookie(res, req, token);
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'siquara_auth=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Dashboard (protegido) ─────────────────────────────────────────────────────

app.get('/dashboard', requireAuth, (req, res) => {
  if (fs.existsSync(DASHBOARD_PATH)) {
    return res.sendFile(DASHBOARD_PATH);
  }
  res.status(500).send('Dashboard não encontrado. Contate o administrador.');
});

// ── API — status ──────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  const token = getToken();
  const accountId = getAccountId();
  let tokenValid = false, account = null;
  if (token && accountId) {
    const r = await validateToken(token, accountId);
    tokenValid = r.valid; account = r.account;
  }
  let savedCampaigns = null;
  if (fs.existsSync(DADOS_PATH)) {
    try {
      const d = JSON.parse(fs.readFileSync(DADOS_PATH, 'utf-8'));
      savedCampaigns = d.campaigns?.length ?? 0;
    } catch {}
  }
  res.json({ status: 'ok', timestamp: new Date().toISOString(), token_valid: tokenValid, account_id: accountId, account, saved_campaigns: savedCampaigns, days_back: getDaysBack() });
});

app.get('/api/token-status', async (req, res) => {
  const token = getToken(), accountId = getAccountId();
  if (!token || !accountId) return res.json({ valid: false, error: 'Variáveis não configuradas' });
  res.json(await validateToken(token, accountId));
});

// ── API — config/token ────────────────────────────────────────────────────────

app.post('/api/token', (req, res) => {
  if ((req.headers.authorization || '') !== `Bearer ${getApiSecret()}`)
    return res.status(401).json({ error: 'Não autorizado' });
  const { token, account_id, anthropic_key, days_back, ig_id } = req.body;
  if (!token && !account_id && !anthropic_key && !days_back && !ig_id)
    return res.status(400).json({ error: 'Informe token, account_id, ig_id, anthropic_key ou days_back' });
  const updated = [];
  if (token)         { process.env.META_ACCESS_TOKEN      = token;              updated.push('META_ACCESS_TOKEN'); }
  if (account_id)    { process.env.META_AD_ACCOUNT_ID     = account_id;         updated.push('META_AD_ACCOUNT_ID'); }
  if (ig_id)         { process.env.INSTAGRAM_ACCOUNT_ID   = ig_id;              updated.push('INSTAGRAM_ACCOUNT_ID'); }
  if (anthropic_key) { process.env.ANTHROPIC_API_KEY      = anthropic_key;      updated.push('ANTHROPIC_API_KEY'); }
  if (days_back)     { process.env.DAYS_BACK              = String(days_back);  updated.push('DAYS_BACK'); }
  res.json({ success: true, updated, message: `Atualizado: ${updated.join(', ')}` });
});

// ── API — dados ───────────────────────────────────────────────────────────────

app.get('/api/dados', (req, res) => {
  const periodoReq = req.query.periodo ? parseInt(req.query.periodo, 10) : null;
  const dadosPath = periodoReq ? dadosPathFor(periodoReq) : DADOS_PATH;
  if (!fs.existsSync(dadosPath))
    return res.json({ message: 'Sem dados. Use POST /api/executar.' });
  try {
    const dados = JSON.parse(fs.readFileSync(dadosPath, 'utf-8'));
    // Informa ao cliente se o período do cache difere do solicitado
    // (só acontece para períodos sem cache dedicado, ex: 15d/30d)
    if (periodoReq && dados.days_back !== periodoReq) {
      dados._periodo_cache = dados.days_back;
      dados._periodo_solicitado = periodoReq;
      dados._aviso = `Cache gerado para ${dados.days_back} dias. Para ${periodoReq} dias, use POST /api/executar com {"periodo":${periodoReq}}.`;
    }
    res.json(dados);
  } catch {
    res.status(500).json({ error: 'Erro ao ler dados' });
  }
});

app.get('/api/resumo', (req, res) => {
  const periodoReq = req.query.periodo ? parseInt(req.query.periodo, 10) : null;
  const dadosPath = periodoReq ? dadosPathFor(periodoReq) : DADOS_PATH;
  if (!fs.existsSync(dadosPath))
    return res.json({ message: 'Sem dados. Use POST /api/executar.' });
  try {
    const dados = JSON.parse(fs.readFileSync(dadosPath, 'utf-8'));
    const insights = dados.insights || [];
    const tipos = [
      'onsite_conversion.messaging_first_reply',
      'onsite_conversion.messaging_conversation_started_7d',
      'onsite_conversion.messaging_conversation_started_30d',
      'lead', 'contact',
    ];
    let investimento = 0, impressoes = 0, cliques = 0, alcance = 0, conversas = 0;
    for (const i of insights) {
      investimento += parseFloat(i.spend || 0);
      impressoes   += parseInt(i.impressions || 0);
      cliques      += parseInt(i.clicks || 0);
      alcance      += parseInt(i.reach || 0);
      const actions = i.actions || [];
      for (const t of tipos) conversas += parseInt(actions.find(a => a.action_type === t)?.value || 0);
    }
    res.json({
      success: true, days_back: dados.days_back, fetched_at: dados.fetched_at,
      resumo: {
        investimento, impressoes, alcance, cliques,
        ctr_medio: impressoes > 0 ? (cliques / impressoes * 100) : 0,
        cpc_medio: cliques > 0 ? (investimento / cliques) : 0,
        conversas: conversas,
        custo_por_conversa: conversas > 0 ? (investimento / conversas) : 0,
      },
    });
  } catch {
    res.status(500).json({ error: 'Erro ao ler dados' });
  }
});

// ── API — Meta buscas ─────────────────────────────────────────────────────────

app.get('/api/campaigns', async (req, res) => {
  const token = getToken(), accountId = getAccountId();
  if (!token || !accountId) return res.status(400).json({ error: 'Token/conta não configurados' });
  const r = await fetchCampaigns(token, accountId);
  if (!r.success) return res.status(502).json({ error: 'Falha Meta API', details: r.errors });
  res.json({ success: true, count: r.data.length, campaigns: r.data });
});

app.get('/api/insights', async (req, res) => {
  const token = getToken(), accountId = getAccountId();
  if (!token || !accountId) return res.status(400).json({ error: 'Token/conta não configurados' });
  const r = await fetchInsights(token, accountId, getDaysBack());
  if (!r.success) return res.status(502).json({ error: 'Falha Meta API', details: r.errors });
  res.json({ success: true, count: r.data.length, insights: r.data });
});

// ── Criativos: ads + insights + creative images ───────────────────────────────
async function fetchAdCreatives(token, accountId, daysBack) {
  const [adsRes, insRes] = await Promise.allSettled([
    (async () => {
      for (const v of ['v19.0', 'v18.0']) {
        try {
          const r = await metaGet(`https://graph.facebook.com/${v}/${accountId}/ads`, {
            access_token: token,
            fields: 'id,name,campaign_id,campaign_name,adset_id,adset_name,status,creative{id,thumbnail_url,image_url,object_type,video_id}',
            limit: 100,
          });
          return r.data?.data || [];
        } catch (e) {
          console.warn(`[CRIATIVOS] ads ${v}:`, e.response?.data?.error?.message || e.message);
        }
      }
      return [];
    })(),
    (async () => {
      for (const v of ['v19.0', 'v18.0']) {
        try {
          const r = await metaGet(`https://graph.facebook.com/${v}/${accountId}/insights`, {
            access_token: token,
            level: 'ad',
            fields: 'ad_id,ad_name,campaign_id,campaign_name,impressions,reach,spend,ctr,cpc,actions,cost_per_action_type,video_thruplay_watched_actions',
            ...periodoParams(daysBack),
            limit: 200,
          });
          return r.data?.data || [];
        } catch (e) {
          console.warn(`[CRIATIVOS] insights ${v}:`, e.response?.data?.error?.message || e.message);
        }
      }
      return [];
    })(),
  ]);

  const ads      = adsRes.status === 'fulfilled' ? adsRes.value : [];
  const insights = insRes.status === 'fulfilled' ? insRes.value : [];

  const insMap = {};
  for (const ins of insights) insMap[ins.ad_id] = ins;

  const criativos = ads
    .map(ad => ({ ...ad, insights: insMap[ad.id] || null }))
    .filter(ad => ad.insights);

  return { success: true, criativos, total_ads: ads.length };
}

app.get('/api/criativos', async (req, res) => {
  const token = getToken(), accountId = getAccountId();
  const daysBack = req.query.periodo ? parseInt(req.query.periodo, 10) : getDaysBack();
  if (!token || !accountId) return res.status(400).json({ error: 'Token/conta não configurados' });
  res.json(await fetchAdCreatives(token, accountId, daysBack));
});

app.get('/api/organico', async (req, res) => {
  const token   = getToken();
  const igId    = getIgId();
  const daysBack = req.query.periodo ? parseInt(req.query.periodo, 10) : getDaysBack();
  console.log(`[GET /api/organico] igId="${igId}" token="${token ? 'OK' : 'FALTANDO'}" daysBack=${daysBack}`);
  if (!token) return res.status(400).json({ error: 'META_ACCESS_TOKEN não configurado' });
  if (!igId)  return res.status(400).json({
    error: 'INSTAGRAM_ACCOUNT_ID não configurado',
    hint: 'Configure via POST /api/token com {ig_id: "17841406453421154"}',
    vars_tentadas: ['INSTAGRAM_ACCOUNT_ID', 'IG_ACCOUNT_ID', 'ID_DA_CONTA_DO_INSTAGRAM', 'INSTAGRAM_ID'],
  });
  res.json(await fetchOrganico(token, igId, daysBack));
});

// ── Debug Instagram ───────────────────────────────────────────────────────────
app.get('/api/debug-instagram', async (req, res) => {
  const token = getToken();
  const igId  = getIgId();
  const out   = {
    config: {
      INSTAGRAM_ACCOUNT_ID: process.env.INSTAGRAM_ACCOUNT_ID || null,
      IG_ACCOUNT_ID:        process.env.IG_ACCOUNT_ID        || null,
      ID_DA_CONTA_DO_INSTAGRAM: process.env.ID_DA_CONTA_DO_INSTAGRAM || null,
      igId_resolvido: igId || '(vazio)',
      token_ok: !!token,
      token_prefix: token ? token.slice(0, 25) + '...' : null,
    },
    testes: [],
  };

  if (!token || !igId) {
    out.erro_fatal = 'token ou igId ausente — configure via POST /api/token';
    return res.json(out);
  }

  // Teste 1: conta
  try {
    const r = await metaGet(`https://graph.facebook.com/v19.0/${igId}`, {
      access_token: token,
      fields: 'id,name,username,followers_count,media_count',
    });
    out.testes.push({ nome: 'Conta v19.0', ok: true, dados: r.data });
  } catch (e) {
    out.testes.push({ nome: 'Conta v19.0', ok: false, code: e.response?.data?.error?.code, msg: e.response?.data?.error?.message || e.message });
  }

  // Teste 2: /media sem campos extras — versão mais simples possível
  for (const v of ['v19.0', 'v18.0', 'v17.0']) {
    try {
      const r = await metaGet(`https://graph.facebook.com/${v}/${igId}/media`, {
        access_token: token,
        fields: 'id,timestamp,media_type',
        limit: 10,
      });
      const posts = r.data?.data || [];
      out.testes.push({
        nome: `media ${v} (simples)`, ok: true,
        count: posts.length,
        primeiro: posts[0] || null,
        raw_data_length: JSON.stringify(r.data).length,
      });
      if (posts.length > 0) break; // achou, não precisa tentar outras versões
    } catch (e) {
      out.testes.push({
        nome: `media ${v} (simples)`, ok: false,
        code: e.response?.data?.error?.code,
        msg:  e.response?.data?.error?.message || e.message,
        raw:  e.response?.data,
      });
    }
  }

  // Teste 3: /media com todos os campos que queremos
  try {
    const r = await metaGet(`https://graph.facebook.com/v19.0/${igId}/media`, {
      access_token: token,
      fields: IG_MEDIA_FIELDS,
      limit: 5,
    });
    const posts = r.data?.data || [];
    out.testes.push({
      nome: 'media v19.0 (campos completos)', ok: true,
      count: posts.length,
      posts: posts.map(p => ({ id: p.id, type: p.media_type, ts: p.timestamp, likes: p.like_count })),
    });
  } catch (e) {
    out.testes.push({
      nome: 'media v19.0 (campos completos)', ok: false,
      code: e.response?.data?.error?.code,
      msg:  e.response?.data?.error?.message || e.message,
    });
  }

  // Teste 4: insights de um post (se conseguiu posts acima)
  const postsOk = out.testes.find(t => t.ok && t.count > 0 && t.posts);
  if (postsOk?.posts?.[0]?.id) {
    const postId = postsOk.posts[0].id;
    try {
      const r = await metaGet(`https://graph.facebook.com/v19.0/${postId}/insights`, {
        access_token: token,
        metric: 'reach,saved,shares',
      });
      out.testes.push({ nome: `insights post ${postId}`, ok: true, dados: r.data?.data });
    } catch (e) {
      out.testes.push({
        nome: `insights post ${postId}`, ok: false,
        code: e.response?.data?.error?.code,
        msg:  e.response?.data?.error?.message || e.message,
      });
    }
  }

  res.json(out);
});

app.get('/api/fetch-all', async (req, res) => {
  const token = getToken(), accountId = getAccountId(), daysBack = getDaysBack();
  if (!token || !accountId) return res.status(400).json({ error: 'Token/conta não configurados' });
  const [cr, ir] = await Promise.allSettled([
    fetchCampaigns(token, accountId),
    fetchInsights(token, accountId, daysBack),
  ]);
  const campaigns = cr.status === 'fulfilled' && cr.value.success ? cr.value.data : [];
  const insights  = ir.status === 'fulfilled' && ir.value.success ? ir.value.data : [];
  const dados = { fetched_at: new Date().toISOString(), account_id: accountId, days_back: daysBack, campaigns, insights };
  try { fs.writeFileSync(DADOS_PATH, JSON.stringify(dados, null, 2), 'utf-8'); } catch {}
  res.json({ success: true, campaigns_count: campaigns.length, insights_count: insights.length });
});

// ── API — Claude análise ──────────────────────────────────────────────────────

app.get('/api/analyze', async (req, res) => {
  const anthropicKey = getAnthropicKey();
  if (!anthropicKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY não configurada' });
  let dados = null;
  if (fs.existsSync(DADOS_PATH)) {
    try { dados = JSON.parse(fs.readFileSync(DADOS_PATH, 'utf-8')); } catch {}
  }
  if (!dados || (!dados.campaigns?.length && !dados.insights?.length)) {
    const token = getToken(), accountId = getAccountId();
    if (token && accountId) {
      const r = await fetchInsights(token, accountId, getDaysBack());
      if (r.success) dados = { insights: r.data, campaigns: [] };
    }
  }
  if (!dados) return res.status(400).json({ error: 'Sem dados. Use /api/fetch-all primeiro.' });

  const client = new Anthropic({ apiKey: anthropicKey });
  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `Você é especialista em marketing digital e Meta Ads para Siquara Mattos.

Analise os dados abaixo (${getDaysBack()} dias) e forneça em Markdown:

## 1. Resumo Executivo
Métricas principais: investimento, alcance, CTR, CPM, CPA, frequência média.

## 2. Top 3 Campanhas (melhor performance)
Por CTR e custo por conversa/ação.

## 3. Campanhas com Problemas (pior performance)
Saturação, custo alto, CTR baixo.

## 4. Análise de Criativos: Vídeo vs Estático
Compare desempenho (CTR, CPM, alcance, engajamento) entre criativos em vídeo e estáticos, e aponte qual formato está performando melhor.

## 5. Recomendações (5 ações concretas)
Baseadas nos dados, priorizadas, para melhorar performance de campanhas e criativos.

Dados:
${JSON.stringify(dados, null, 1).slice(0, 18000)}

Responda em português brasileiro. Seja direto e use tabelas quando útil.`,
      }],
    });
    res.json({ success: true, analysis: message.content[0].text, fetched_at: dados.fetched_at });
  } catch (e) {
    res.status(500).json({ error: 'Erro Claude API', details: e.message });
  }
});

// ── API — executar agente completo ────────────────────────────────────────────

// Busca campanhas+insights de um período, salva no cache correspondente
// (dadosPathFor) e opcionalmente gera análise Claude. Usada por /api/executar,
// /api/setup e pelo cron horário de 24h — evita triplicar essa lógica.
async function executarAgente(daysBack, { comAnalise = true } = {}) {
  const token = getToken(), accountId = getAccountId(), anthropicKey = getAnthropicKey();
  const log = [`Iniciando (período: ${daysBack} dias)...`];
  if (!token || !accountId) return { success: false, error: 'Token/conta não configurados', log };

  const [cr, ir] = await Promise.allSettled([
    fetchCampaigns(token, accountId),
    fetchInsights(token, accountId, daysBack),
  ]);
  const campaigns = cr.status === 'fulfilled' && cr.value.success ? cr.value.data : [];
  const insights  = ir.status === 'fulfilled' && ir.value.success ? ir.value.data : [];
  log.push(`Campanhas: ${campaigns.length}`, `Insights: ${insights.length}`);

  const dados = { fetched_at: new Date().toISOString(), account_id: accountId, days_back: daysBack, campaigns, insights };
  try {
    fs.writeFileSync(dadosPathFor(daysBack), JSON.stringify(dados, null, 2), 'utf-8');
    log.push('Dados salvos');
  } catch (e) { log.push(`Erro ao salvar: ${e.message}`); }

  let analysis = null;
  if (comAnalise && anthropicKey && (campaigns.length || insights.length)) {
    try {
      const client = new Anthropic({ apiKey: anthropicKey });
      const msg = await client.messages.create({
        model: 'claude-opus-4-7', max_tokens: 2048,
        messages: [{ role: 'user', content: `Analise brevemente as campanhas Meta de Siquara Mattos (${daysBack} dias). Foque em CTR, CPM, CPA, alcance e recomendações urgentes.\n\nDados:\n${JSON.stringify(dados, null, 1).slice(0, 15000)}` }],
      });
      analysis = msg.content[0].text;
      log.push('Análise Claude concluída');
    } catch (e) { log.push(`Erro Claude: ${e.message}`); }
  }

  return { success: true, summary: { campaigns: campaigns.length, insights: insights.length, has_analysis: !!analysis }, log, analysis, fetched_at: dados.fetched_at };
}

app.post('/api/executar', async (req, res) => {
  if ((req.headers.authorization || '') !== `Bearer ${getApiSecret()}`)
    return res.status(401).json({ error: 'Não autorizado' });

  // periodo pode vir do body (dashboard) ou fallback para env/padrão
  const periodoBody = req.body?.periodo ? parseInt(req.body.periodo, 10) : null;
  const daysBack = periodoBody || getDaysBack();
  const result = await executarAgente(daysBack, { comAnalise: true });
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// ── Setup completo numa só requisição (evita restart de container) ────────────
app.post('/api/setup', async (req, res) => {
  if ((req.headers.authorization || '') !== `Bearer ${getApiSecret()}`)
    return res.status(401).json({ error: 'Não autorizado' });

  const { token, account_id, ig_id, anthropic_key, days_back, periodo, executar = true } = req.body;
  const updated = [];

  if (token)         { process.env.META_ACCESS_TOKEN    = token;              updated.push('META_ACCESS_TOKEN'); }
  if (account_id)    { process.env.META_AD_ACCOUNT_ID   = account_id;         updated.push('META_AD_ACCOUNT_ID'); }
  if (ig_id)         { process.env.INSTAGRAM_ACCOUNT_ID = ig_id;              updated.push('INSTAGRAM_ACCOUNT_ID'); }
  if (anthropic_key) { process.env.ANTHROPIC_API_KEY    = anthropic_key;      updated.push('ANTHROPIC_API_KEY'); }
  if (days_back)     { process.env.DAYS_BACK             = String(days_back); updated.push('DAYS_BACK'); }

  if (!executar) return res.json({ success: true, updated });

  const db = periodo || getDaysBack();
  const result = await executarAgente(db, { comAnalise: true });
  res.json({ ...result, updated });
});

// ── Proxy de imagem (evita CORS nas fotos do Instagram CDN) ──────────────────
app.get('/api/proxy-image', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'URL inválida' }); }
  const allowed = ['.cdninstagram.com', '.fbcdn.net'];
  if (!allowed.some(d => parsed.hostname.endsWith(d))) {
    return res.status(403).json({ error: 'Domínio não permitido' });
  }
  try {
    const r = await axios.get(url, {
      responseType: 'stream', timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    r.data.pipe(res);
  } catch { res.status(502).send('Proxy error'); }
});

// ── Cron: atualiza o cache de 24h a cada hora ─────────────────────────────────
cron.schedule('0 * * * *', async () => {
  console.log('[CRON] Atualizando dados das últimas 24h...');
  try {
    const r = await executarAgente(1, { comAnalise: false });
    console.log('[CRON] 24h:', (r.log || []).join(' | '));
  } catch (e) {
    console.error('[CRON] Erro ao atualizar 24h:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

app.listen(PORT, () => {
  console.log(`Siquara Server porta ${PORT}`);
  console.log(`Token: ${getToken() ? 'OK' : 'FALTANDO'} | Conta: ${getAccountId() || 'FALTANDO'} | Anthropic: ${getAnthropicKey() ? 'OK' : 'FALTANDO'}`);
});
