// server.js
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CHAT_ROOM = process.env.CHAT_ROOM || 'global';

// Liste de origini separate prin virgulă (ex: "https://smartcreator.onrender.com,https://smartcreator.ro,*.netlify.app")
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Permite Origin: null (file://, webviews) dacă ALLOW_NULL_ORIGIN=1
const ALLOW_NULL_ORIGIN = String(process.env.ALLOW_NULL_ORIGIN || '').trim() === '1';

// ---- sanity checks
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[FATAL] Lipsesc env SUPABASE_URL sau SUPABASE_SERVICE_KEY.');
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const app = express();
app.use(express.json({ limit: '256kb' }));

/* ---------------- CORS ---------------- */
function isAllowedOrigin(origin) {
  if (!origin) return true;                       // fără header Origin
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

app.use(cors({
  origin(origin, cb) { isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('CORS blocked: ' + origin)); },
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors({
  origin(origin, cb) { isAllowedOrigin(origin) ? cb(null, true) : cb(new Error('CORS blocked: ' + origin)); }
}));

/* --------------- XP / LEVEL --------------- */
/** câte puncte dăm per mesaj */
function xpForMessage(text='') {
  const len = String(text).trim().length;
  const base = 8;
  const bonus = Math.floor(Math.max(0, len - 120) / 120); // +1 per 120 caractere după primele 120
  return Math.min(base + bonus, 20);                      // cap la 20
}
/** timp minim între două acordări de XP per user (anti-spam) */
const XP_COOLDOWN_MS = 15_000;
/** memorie locală pentru cooldown */
const lastXpGrant = new Map(); // email -> ts

function calcLevelFromXP(xp) {
  // progresie: pentru fiecare nivel, cerința crește cu +25 XP
  // L1: 0 total, L2: +50, L3:+75, L4:+100, L5:+125, ...
  let level = 1;
  let need = 50;
  let rest = Math.max(0, Math.floor(xp));
  while (rest >= need && level < 200) {
    rest -= need;
    level += 1;
    need += 25;
  }
  return { level, into: rest, toNext: need, pct: Math.round(rest * 100 / need) };
}

async function awardXPByEmail(email, text) {
  if (!email) return null;

  // cooldown memorie
  const last = lastXpGrant.get(email) || 0;
  if (Date.now() - last < XP_COOLDOWN_MS) return null;
  lastXpGrant.set(email, Date.now());

  const inc = xpForMessage(text);

  // citește profilul
  const { data: prof, error: pErr } = await supa
    .from('profiles')
    .select('user_id,email,xp,level,full_name')
    .eq('email', email)
    .maybeSingle();

  if (pErr) {
    console.error('[XP] read profile error:', pErr.message);
    return null;
  }
  if (!prof) {
    // Dacă nu există rând, nu inserăm (de obicei profiles are user_id NOT NULL); doar ieșim curat
    return null;
  }

  const newXP = (prof.xp || 0) + inc;
  const { level } = calcLevelFromXP(newXP);

  const { error: uErr } = await supa
    .from('profiles')
    .update({ xp: newXP, level, last_xp_at: new Date().toISOString() })
    .eq('email', email);

  if (uErr) {
    console.error('[XP] update profile error:', uErr.message);
    return null;
  }

  return { xp: newXP, level, inc, name: prof.full_name || email };
}

async function nameLevelByEmails(emails) {
  if (!emails.length) return new Map();
  const { data, error } = await supa
    .from('profiles')
    .select('email,full_name,level')
    .in('email', emails);

  const map = new Map();
  if (!error && Array.isArray(data)) {
    for (const r of data) {
      map.set(r.email, { name: r.full_name || r.email, level: r.level || 1 });
    }
  }
  return map;
}

/* ---------------- ROUTES ---------------- */
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    room: CHAT_ROOM,
    cors: CORS_ORIGIN,
    allow_null_origin: ALLOW_NULL_ORIGIN,
    supa_url_set: !!SUPABASE_URL,
    service_key_set: !!SUPABASE_SERVICE_KEY
  });
});

// === Chat API ===
app.get('/api/history', async (req, res) => {
  try {
    const { data, error } = await supa
      .from('chat_messages')
      .select('cid,user,text,ts,room')
      .eq('room', CHAT_ROOM)
      .order('ts', { ascending: true })
      .limit(500);

    if (error) {
      console.error('[HISTORY] Supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // user = email în DB; transformăm la {user: displayName, level}
    const emails = [...new Set((data || []).map(r => r.user).filter(Boolean))];
    const meta = await nameLevelByEmails(emails);

    const shaped = (data || []).map(r => {
      const m = meta.get(r.user);
      return {
        cid: r.cid,
        user: m?.name || r.user,   // nume de afișare
        level: m?.level || 1,      // nivel afișat
        text: r.text,
        ts: r.ts,
        room: r.room
      };
    });

    res.json(shaped);
  } catch (e) {
    console.error('[HISTORY] Exception:', e);
    res.status(500).json({ error: 'history-failed' });
  }
});

app.post('/api/send', async (req, res) => {
  try {
    const { user: email, name, text, cid, ts } = req.body || {};
    // în DB păstrăm email-ul în coloana "user"
    const row = {
      room: CHAT_ROOM,
      cid: cid || null,
      user: String(email || 'Anon').slice(0, 160), // <- EMAIL
      text: String(text || '').slice(0, 4000),
      ts: Number(ts || Date.now())
    };

    const { error } = await supa.from('chat_messages').insert(row);
    if (error) {
      console.error('[SEND] Supabase insert error:', error.message, { row });
      return res.status(500).json({ error: error.message });
    }

    // XP + nume/nivel pentru broadcast
    const xpInfo = await awardXPByEmail(email, text);
    const displayName = xpInfo?.name || name || email;
    const displayLevel = xpInfo?.level || undefined;

    broadcast({ type: 'message', data: { ...row, user: displayName, level: displayLevel } });
    res.json({ ok: true });
  } catch (e) {
    console.error('[SEND] Exception:', e);
    res.status(500).json({ error: 'send-failed' });
  }
});

/* ---------------- WS ---------------- */
const server = app.listen(PORT, () => {
  console.log(`[BOOT] Port=${PORT} Room=${CHAT_ROOM}`);
  console.log(`[BOOT] CORS whitelist:`, CORS_ORIGIN.length ? CORS_ORIGIN : '(all)');
  console.log(`[BOOT] Allow Origin "null":`, ALLOW_NULL_ORIGIN);
  console.log(`[BOOT] Supabase URL set:`, !!SUPABASE_URL);
  console.log(`[BOOT] Service key set:`, !!SUPABASE_SERVICE_KEY);
});

const wss = new WebSocketServer({ server });
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { try { if (c.readyState === 1) c.send(msg); } catch {} });
}

wss.on('connection', ws => {
  ws.on('message', async buf => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    // clientul trimite {type:'send', user:<email>, name:<displayName>, text, cid}
    if (msg?.type === 'send') {
      const email = String(msg.user || 'Anon').slice(0, 160); // EMAIL
      const row = {
        room: CHAT_ROOM,
        cid: msg.cid || null,
        user: email,
        text: String(msg.text || '').slice(0, 4000),
        ts: Date.now()
      };
      const { error } = await supa.from('chat_messages').insert(row);
      if (error) {
        console.error('[WS send] insert error:', error.message);
        try { ws.send(JSON.stringify({ type:'error', error: error.message })); } catch {}
        return;
      }

      const xpInfo = await awardXPByEmail(email, row.text);
      const displayName = xpInfo?.name || msg.name || email;
      const displayLevel = xpInfo?.level || undefined;

      broadcast({ type:'message', data: { ...row, user: displayName, level: displayLevel } });
    }

    // typing passthrough
    if (msg?.type === 'typing') {
      broadcast({ type:'typing', data: { active: !!msg.active, user: msg.user || 'Anon', id: ws._id || '' } });
    }
  });

  ws._id = Math.random().toString(16).slice(2);
  try { ws.send(JSON.stringify({ type:'hello', id: ws._id })); } catch {}
});
