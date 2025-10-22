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
  // nu ies — pornesc totuși ca să vezi clar la /healthz ce lipsește
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cors({
  origin(origin, cb) {
    // 1) permite request-uri fără Origin (same-origin, curl, preflight exotic)
    if (!origin) return cb(null, true);

    // 2) dacă nu ai setat nimic în env, permite tot
    if (!CORS_ORIGIN.length) return cb(null, true);

    // 3) wildcard suport
    if (CORS_ORIGIN.includes('*')) return cb(null, true);

    // 4) match direct sau pe host (ex: http/https, subdomain)
    try {
      const o = new URL(origin);
      const ok = CORS_ORIGIN.some(a => {
        try { 
          const u = new URL(a);
          return u.host === o.host; // acceptă aceeași gazdă, indiferent de schemă
        } catch {
          return a === origin;      // string exact
        }
      });
      if (ok) return cb(null, true);
    } catch {}

    return cb(new Error('CORS blocked: ' + origin));
  },
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

// preflight helper (optional)
app.options('*', cors());


app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    room: CHAT_ROOM,
    cors: CORS_ORIGIN,
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

    // broadcast prin WS
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
