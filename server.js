// server.js
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');

/* ========= ENV ========= */
const PORT                 = process.env.PORT || 10000;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CHAT_ROOM            = process.env.CHAT_ROOM || 'global';

/* CORS: CSV de origini (ex: "https://smartcreator.ro,https://*.netlify.app") */
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
/* Permite Origin: null (file://, webview) by default = 1 pentru dev */
const ALLOW_NULL_ORIGIN = String(process.env.ALLOW_NULL_ORIGIN ?? '1').trim() === '1';

/* ========= SANITY ========= */
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[FATAL] Lipsesc SUPABASE_URL / SUPABASE_SERVICE_KEY');
  process.exit(1);
}

/* ========= SUPABASE (service) ========= */
const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/* ========= APP ========= */
const app = express();
app.use(express.json({ limit: '512kb' }));

/* ========= CORS ========= */
function isAllowedOrigin(origin) {
  if (!origin) return true; // fără header Origin
  if (origin === 'null') return ALLOW_NULL_ORIGIN || CORS_ORIGIN.includes('*') || CORS_ORIGIN.includes('null');
  if (!CORS_ORIGIN.length) return true;
  if (CORS_ORIGIN.includes('*')) return true;

  let host = '';
  try { host = new URL(origin).hostname; } catch { return false; }

  return CORS_ORIGIN.some(p => {
    try { p = new URL(p).hostname; } catch {}
    if (!p) return false;
    if (p === host) return true;
    if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1));
    if (p.startsWith('*'))  return host.endsWith(p.slice(1));
    return false;
  });
}

const corsDynamic = cors({
  origin(origin, cb) { isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('CORS blocked: ' + origin)); },
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
});
app.use(corsDynamic);
app.options('*', corsDynamic);

/* ========= XP / LEVEL ========= */
/* Formulă UNICĂ (quadratic): level = 1 + floor(sqrt(xp / 100)) */
function levelFromXp(xpInt = 0) {
  const xp = Math.max(0, Math.floor(xpInt));
  const lvl = 1 + Math.floor(Math.sqrt(xp / 100));
  const prevThreshold = (lvl - 1) * (lvl - 1) * 100; // (L-1)^2 *100
  const nextThreshold = (lvl) * (lvl) * 100;         // L^2 *100
  const cur = xp - prevThreshold;
  const next = nextThreshold - prevThreshold;
  const pct = Math.max(0, Math.min(100, Math.round((cur / next) * 100)));
  return { level: lvl, cur, next, total: xp, pct, prevThreshold, nextThreshold };
}

/* Valori XP pentru evenimente */
const XP_BY_TYPE = {
  profile_complete: 50,     // o singură dată (unic pe (user,type))
  lesson_complete: 40,      // per lecție (unic pe meta.key)
  quiz_pass: 60,            // per lecție (unic pe meta.key)
  chat_message: null        // calculat din conținut (8..20)
};

/* Anti-spam chat XP */
const XP_COOLDOWN_MS = 15_000;
const lastXpGrant = new Map(); // email -> ts

/* Helpers */
async function getUserFromToken(bearerOrRaw) {
  const token = (bearerOrRaw || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user; // { id, email, ... }
}

async function readProfileByEmail(email) {
  const { data, error } = await supa
    .from('profiles')
    .select('user_id,email,full_name,level,xp')
    .eq('email', email)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/* Apel centralizat la RPC add_xp (și sincronizează profiles prin funcția din Punctul C) */
async function addXp(uid, delta, type, meta = {}) {
  const { data, error } = await supa.rpc('add_xp', {
    uid,
    delta,
    ev_type: type,
    ev_meta: meta
  });
  if (error) {
    // Dacă e duplicate key (once/perkey), returnăm totalul actual fără a da 500
    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('duplicate') || msg.includes('unique')) {
      // citesc totalul din user_xp
      const { data: ux } = await supa.from('user_xp').select('xp').eq('user_id', uid).maybeSingle();
      return ux?.xp ?? null;
    }
    throw error;
  }
  return data; // new_total XP
}

/* XP din text (chat) */
function xpForMessage(text='') {
  const len = String(text).trim().length;
  const base = 8;
  const bonus = Math.floor(Math.max(0, len - 120) / 120);
  return Math.min(base + bonus, 20);
}

/* ================== ROUTES ================== */
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    room: CHAT_ROOM,
    cors: CORS_ORIGIN.length ? CORS_ORIGIN : '(all)',
    allow_null_origin: ALLOW_NULL_ORIGIN,
    supa_url: !!SUPABASE_URL,
    service_key: !!SUPABASE_SERVICE_KEY
  });
});

/* ---------- XP API ---------- */
// GET /api/xp/me  (Authorization: Bearer <supabase access token>)
app.get('/api/xp/me', async (req, res) => {
  try {
    const user = await getUserFromToken(req.headers.authorization || '');
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    // ia totalul din user_xp (sau 0)
    const { data: ux } = await supa.from('user_xp').select('xp').eq('user_id', user.id).maybeSingle();
    const total = ux?.xp || 0;
    const shaped = levelFromXp(total);
    res.json(shaped);
  } catch (e) {
    console.error('[xp/me]', e?.message || e);
    res.status(500).json({ error: 'xp-me-failed' });
  }
});

/* POST /api/xp/earn  { token, type, meta }  */
app.post('/api/xp/earn', async (req, res) => {
  try {
    const { token, type, meta = {} } = req.body || {};
    const user = await getUserFromToken(token || req.headers.authorization || '');
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    if (!type || !(type in XP_BY_TYPE)) {
      return res.status(400).json({ error: 'bad-type' });
    }

    let delta = XP_BY_TYPE[type];
    if (type === 'chat_message') {
      return res.status(400).json({ error: 'chat-message-via-ws-only' });
    }

    const newTotal = await addXp(user.id, delta, type, meta);
    const shaped   = levelFromXp(newTotal || 0);
    res.json({ ok: true, ...shaped });
  } catch (e) {
    console.error('[xp/earn]', e?.message || e);
    res.status(500).json({ error: 'xp-earn-failed' });
  }
});

/* GET /api/xp/leaderboard?period=7d */
app.get('/api/xp/leaderboard', async (req, res) => {
  try {
    const period = String(req.query.period || '7d').toLowerCase();
    const map = { '7d': "7 days", '30d': "30 days", '24h': "24 hours" };
    const span = map[period] || "7 days";
    const since = new Date(Date.now() - (span.includes('hours') ? 24*60*60*1000 : 7*24*60*60*1000));
    const { data, error } = await supa.rpc('xp_leaderboard', { since: since.toISOString() });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    console.error('[xp/leaderboard]', e?.message || e);
    res.status(500).json({ error: 'xp-leaderboard-failed' });
  }
});

/* ---------- Chat API ---------- */
app.get('/api/history', async (req, res) => {
  try {
    const { data, error } = await supa
      .from('chat_messages')
      .select('cid,user,text,ts,room')
      .eq('room', CHAT_ROOM)
      .order('ts', { ascending: true })
      .limit(500);

    if (error) return res.status(500).json({ error: error.message });

    // map email -> (name, level)
    const emails = [...new Set((data || []).map(r => r.user).filter(Boolean))];
    const meta = new Map();
    if (emails.length) {
      const q = await supa.from('profiles').select('email,full_name,level').in('email', emails);
      if (!q.error && Array.isArray(q.data)) {
        for (const r of q.data) meta.set(r.email, { name: r.full_name || r.email, level: r.level || 1 });
      }
    }

    const shaped = (data || []).map(r => {
      const m = meta.get(r.user);
      return {
        cid: r.cid,
        user: m?.name || r.user,
        level: m?.level || 1,
        text: r.text,
        ts: r.ts,
        room: r.room
      };
    });

    res.json(shaped);
  } catch (e) {
    console.error('[history]', e);
    res.status(500).json({ error: 'history-failed' });
  }
});

app.post('/api/send', async (req, res) => {
  try {
    const { user: email, name, text, cid, ts } = req.body || {};
    const row = {
      room: CHAT_ROOM,
      cid: cid || null,
      user: String(email || 'Anon').slice(0, 160), // EMAIL în DB
      text: String(text || '').slice(0, 4000),
      ts: Number(ts || Date.now())
    };
    const ins = await supa.from('chat_messages').insert(row);
    if (ins.error) return res.status(500).json({ error: ins.error.message });

    // XP via RPC add_xp (cu cooldown pe email)
    let displayName = name || email;
    let displayLevel = 1;

    try {
      // cooldown
      const last = lastXpGrant.get(email) || 0;
      if (Date.now() - last >= XP_COOLDOWN_MS) {
        lastXpGrant.set(email, Date.now());
        const prof = await readProfileByEmail(email);
        if (prof?.user_id) {
          const inc = xpForMessage(text);
          const total = await addXp(prof.user_id, inc, 'chat_message', { cid: cid || null });
          const shaped = levelFromXp(total || 0);
          displayLevel = shaped.level;
          displayName  = prof.full_name || email;
        }
      } else {
        const prof = await readProfileByEmail(email);
        displayLevel = prof?.level || 1;
        displayName  = (prof?.full_name || name || email);
      }
    } catch (e) {
      console.error('[XP chat]', e?.message || e);
    }

    broadcast({ type: 'message', data: { ...row, user: displayName, level: displayLevel } });
    res.json({ ok: true });
  } catch (e) {
    console.error('[send]', e);
    res.status(500).json({ error: 'send-failed' });
  }
});

/* ========= WS ========= */
const server = app.listen(PORT, () => {
  console.log(`[BOOT] Port=${PORT} Room=${CHAT_ROOM}`);
  console.log(`[BOOT] CORS:`, CORS_ORIGIN.length ? CORS_ORIGIN : '(all)');
  console.log(`[BOOT] Allow Origin "null":`, ALLOW_NULL_ORIGIN);
});

const wss = new WebSocketServer({ server });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { try { if (c.readyState === 1) c.send(msg); } catch {} });
}

wss.on('connection', ws => {
  ws._id = Math.random().toString(16).slice(2);
  // trimite id-ul pentru voice signaling
  try { ws.send(JSON.stringify({ type:'voice-id', data:{ id: ws._id } })); } catch {}

  ws.on('message', async buf => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    // --- CHAT ---
    if (msg?.type === 'send') {
      const email = String(msg.user || 'Anon').slice(0, 160);
      const row = { room: CHAT_ROOM, cid: msg.cid || null, user: email, text: String(msg.text||'').slice(0,4000), ts: Date.now() };
      const ins = await supa.from('chat_messages').insert(row);
      if (ins.error) {
        try { ws.send(JSON.stringify({ type:'error', error: ins.error.message })); } catch {}
        return;
      }

      let displayName = msg.name || email;
      let displayLevel = 1;

      try {
        const last = lastXpGrant.get(email) || 0;
        if (Date.now() - last >= XP_COOLDOWN_MS) {
          lastXpGrant.set(email, Date.now());
          const prof = await readProfileByEmail(email);
          if (prof?.user_id) {
            const inc = xpForMessage(row.text);
            const total = await addXp(prof.user_id, inc, 'chat_message', { cid: row.cid || null });
            const shaped = levelFromXp(total || 0);
            displayLevel = shaped.level;
            displayName  = prof.full_name || email;
          }
        } else {
          const prof = await readProfileByEmail(email);
          displayLevel = prof?.level || 1;
          displayName  = (prof?.full_name || msg.name || email);
        }
      } catch (e) {
        console.error('[WS XP chat]', e?.message || e);
      }

      broadcast({ type:'message', data: { ...row, user: displayName, level: displayLevel } });
      return;
    }

    // --- TYPING ---
    if (msg?.type === 'typing') {
      broadcast({ type:'typing', data: { active: !!msg.active, user: msg.user || 'Anon', id: ws._id } });
      return;
    }

    // --- VOICE SIGNALING ---
    if (msg?.type === 'voice-join') {
      broadcast({ type:'voice-join', data:{ id: ws._id, user: msg.user || '—' } });
      return;
    }
    if (msg?.type === 'voice-leave') {
      broadcast({ type:'voice-leave', data:{ id: ws._id } });
      return;
    }
    if (msg?.type === 'voice-mute') {
      broadcast({ type:'voice-mute', data:{ id: ws._id, muted: !!msg.muted } });
      return;
    }
    if (msg?.type === 'voice-offer') {
      broadcast({ type:'voice-offer', data:{ from: ws._id, to: msg.to, sdp: msg.sdp } });
      return;
    }
    if (msg?.type === 'voice-answer') {
      broadcast({ type:'voice-answer', data:{ from: ws._id, to: msg.to, sdp: msg.sdp } });
      return;
    }
    if (msg?.type === 'voice-ice') {
      broadcast({ type:'voice-ice', data:{ from: ws._id, to: msg.to, candidate: msg.candidate } });
      return;
    }
  });

  ws.on('close', () => {
    try { broadcast({ type:'voice-leave', data:{ id: ws._id } }); } catch {}
  });
});
