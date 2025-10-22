// server.js
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CHAT_ROOM = process.env.CHAT_ROOM || 'global';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);

// ---- sanity checks
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[FATAL] Lipsesc env SUPABASE_URL sau SUPABASE_SERVICE_KEY. Vezi Render -> Environment.');
  // pornesc oricum ca să poți vedea la /healthz
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS permisiv dar controlabil prin CORS_ORIGIN
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!CORS_ORIGIN.length) return cb(null, true);
    if (CORS_ORIGIN.includes('*')) return cb(null, true);

    let host = '';
    try { host = new URL(origin).hostname; } catch { return cb(new Error('CORS blocked: ' + origin)); }

    const ok = CORS_ORIGIN.some(raw => {
      let pat = String(raw || '').trim();
      if (!pat) return false;

      // dacă e URL normal, extragem hostname
      try { pat = new URL(pat).hostname; } catch {}

      // exact match
      if (pat === host) return true;

      // wildcard-uri simple: *.domeniu.tld sau *ceva.tld
      if (pat.startsWith('*.')) return host === pat.slice(2) || host.endsWith(pat.slice(1));
      if (pat.startsWith('*'))  return host.endsWith(pat.slice(1));

      return false;
    });

    return ok ? cb(null, true) : cb(new Error('CORS blocked: ' + origin));
  },
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

app.options('*', cors());

// ===== Level/XP config =====
const XP_RULES = {
  chat_message:     { amount: 2,  cooldownSec: 15,  dailyCap: 60 }, // ~30 mesaje/zi contorizate
  lesson_complete:  { amount: 40, perKey: true },                   // meta.key = lessonId
  quiz_pass:        { amount: 25, perKey: true },                   // meta.key = lessonId
  voice_join:       { amount: 10, cooldownSec: 300, dailyCap: 20 }, // max ~2/zi
  profile_complete: { amount: 20, once: true }                      // o singură dată
};

// verifică token-ul Supabase și returnează user-ul
async function getUserFromToken(token) {
  if (!token) return null;
  try {
    const { data, error } = await supa.auth.getUser(token);
    if (error) return null;
    return data?.user || null;
  } catch { return null; }
}

// helper: today UTC
function startOfTodayUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

// calculează progres nivel (fără persist)
function levelFromXp(total) {
  let lvl = 1, need = 100, step = 40, xp = Math.max(0, total);
  while (xp >= need) { xp -= need; lvl++; need += step; if (lvl > 999) break; }
  return { level: lvl, cur: xp, next: need, total, pct: Math.round((xp/need)*100) };
}

// ===== Health =====
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    room: CHAT_ROOM,
    cors: CORS_ORIGIN,
    supa_url_set: !!SUPABASE_URL,
    service_key_set: !!SUPABASE_SERVICE_KEY
  });
});

// ===== XP: eu =====
app.get('/api/xp/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i,'') || req.query.token;
    const user = await getUserFromToken(token);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { data } = await supa.from('user_xp').select('xp').eq('user_id', user.id).maybeSingle();
    const xp = data?.xp || 0;
    res.json(levelFromXp(xp));
  } catch (e) {
    console.error('[xp/me] ', e);
    res.status(500).json({ error: 'xp-me-failed' });
  }
});

// ===== XP: earn =====
app.post('/api/xp/earn', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i,'') || req.body?.token;
    const user = await getUserFromToken(token);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { type, meta = {} } = req.body || {};
    const rule = XP_RULES[type];
    if (!rule) return res.status(400).json({ error: 'unknown-type' });

    const sinceToday = startOfTodayUTC();

    // once
    if (rule.once) {
      const { data: once } = await supa
        .from('xp_events').select('id', { count: 'exact', head: true })
        .eq('user_id', user.id).eq('type', type);
      if ((once?.length ?? 0) > 0) return res.json({ ok: true, skipped: 'once', ...levelFromXp((await currentXp(user.id))) });
    }

    // perKey
    if (rule.perKey) {
      const k = String(meta.key || '').trim();
      if (!k) return res.status(400).json({ error: 'missing-meta-key' });
      const { data: exists } = await supa
        .from('xp_events').select('id', { count: 'exact', head: true })
        .eq('user_id', user.id).eq('type', type).contains('meta', { key: k });
      if ((exists?.length ?? 0) > 0) return res.json({ ok: true, skipped: 'perKey', ...levelFromXp((await currentXp(user.id))) });
    }

    // daily cap
    if (rule.dailyCap) {
      const { data: today } = await supa
        .from('xp_events').select('amount')
        .eq('user_id', user.id).eq('type', type)
        .gte('created_at', sinceToday);
      const todaySum = (today || []).reduce((s, r) => s + (r.amount || 0), 0);
      if (todaySum >= rule.dailyCap) return res.json({ ok: true, skipped: 'daily-cap', ...levelFromXp((await currentXp(user.id))) });
    }

    // cooldown
    if (rule.cooldownSec) {
      const { data: last } = await supa
        .from('xp_events').select('created_at')
        .eq('user_id', user.id).eq('type', type)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (last?.created_at) {
        const diff = (Date.now() - new Date(last.created_at).getTime()) / 1000;
        if (diff < rule.cooldownSec) return res.json({ ok: true, skipped: 'cooldown', ...levelFromXp((await currentXp(user.id))) });
      }
    }

    // grant XP prin RPC
    const { data: newTotal, error } = await supa.rpc('add_xp', {
      uid: user.id, delta: rule.amount, ev_type: type, ev_meta: meta
    });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true, ...levelFromXp(newTotal || 0) });
  } catch (e) {
    console.error('[xp/earn] ', e);
    res.status(500).json({ error: 'xp-earn-failed' });
  }
});

async function currentXp(uid){
  const { data } = await supa.from('user_xp').select('xp').eq('user_id', uid).maybeSingle();
  return data?.xp || 0;
}

// ===== XP: leaderboard =====
app.get('/api/xp/leaderboard', async (req, res) => {
  try {
    const period = String(req.query.period || '7d');
    let since = new Date(0).toISOString();
    if (period === '7d')  since = new Date(Date.now() - 7*864e5).toISOString();
    if (period === '30d') since = new Date(Date.now() - 30*864e5).toISOString();

    const { data, error } = await supa.rpc('xp_leaderboard', { since });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) {
    console.error('[xp/leaderboard] ', e);
    res.status(500).json({ error: 'xp-leaderboard-failed' });
  }
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
    res.json(data || []);
  } catch (e) {
    console.error('[HISTORY] Exception:', e);
    res.status(500).json({ error: 'history-failed' });
  }
});

app.post('/api/send', async (req, res) => {
  try {
    const { user, text, cid, ts } = req.body || {};
    const row = {
      room: CHAT_ROOM,
      cid: cid || null,
      user: String(user || 'Anon').slice(0, 160),
      text: String(text || '').slice(0, 4000),
      ts: Number(ts || Date.now())
    };

    const { error } = await supa.from('chat_messages').insert(row);
    if (error) {
      console.error('[SEND] Supabase insert error:', error.message, { row });
      return res.status(500).json({ error: error.message });
    }

    broadcast({ type: 'message', data: row });
    res.json({ ok: true });
  } catch (e) {
    console.error('[SEND] Exception:', e);
    res.status(500).json({ error: 'send-failed' });
  }
});

// === HTTP server + WS ===
const server = app.listen(PORT, () => {
  console.log(`[BOOT] Port=${PORT} Room=${CHAT_ROOM}`);
  console.log(`[BOOT] CORS whitelist:`, CORS_ORIGIN.length ? CORS_ORIGIN : '(all)');
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

    // clientul trimite {type:'send', user, text, cid}
    if (msg?.type === 'send') {
      const row = {
        room: CHAT_ROOM,
        cid: msg.cid || null,
        user: String(msg.user || 'Anon').slice(0, 160),
        text: String(msg.text || '').slice(0, 4000),
        ts: Date.now()
      };
      const { error } = await supa.from('chat_messages').insert(row);
      if (error) {
        console.error('[WS send] insert error:', error.message);
        try { ws.send(JSON.stringify({ type:'error', error: error.message })); } catch {}
        return;
      }
      broadcast({ type:'message', data: row });
    }

    // typing passthrough
    if (msg?.type === 'typing') {
      broadcast({ type:'typing', data: { active: !!msg.active, user: msg.user || 'Anon', id: ws._id || '' } });
    }
  });

  // id simplu pt typing
  ws._id = Math.random().toString(16).slice(2);
  try { ws.send(JSON.stringify({ type:'hello', id: ws._id })); } catch {}
});
