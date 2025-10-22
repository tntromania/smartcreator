// server.js
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CHAT_ROOM = process.env.CHAT_ROOM || 'global';

// Sanitize CORS_ORIGIN (în caz că ai pus din greșeală "CORS_ORIGIN=" în Value)
const ORIGINS_RAW = (process.env.CORS_ORIGIN || '').replace(/^CORS_ORIGIN=/, '');
const CORS_ORIGIN = ORIGINS_RAW.split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_NULL_ORIGIN = process.env.ALLOW_NULL_ORIGIN === '1';

// ── sanity
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[FATAL] Lipsesc SUPABASE_URL / SUPABASE_SERVICE_KEY (Render → Settings → Environment).');
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// === Express mai întâi, apoi .use(...)
const app = express();

const corsOptions = {
  origin(origin, cb) {
    // 1) Permite fără Origin (ex: same-origin, curl, unele preflight-uri)
    if (!origin || origin === 'null') {
      return ALLOW_NULL_ORIGIN ? cb(null, true) : cb(new Error('CORS blocked: null'));
    }

    // 2) Dacă n-ai setat listă → permite tot
    if (!CORS_ORIGIN.length) return cb(null, true);

    // 3) wildcard
    if (CORS_ORIGIN.includes('*')) return cb(null, true);

    // 4) match pe host (acceptă http/https)
    try {
      const o = new URL(origin);
      const ok = CORS_ORIGIN.some(a => {
        try { return new URL(a).host === o.host; }
        catch { return a === origin; }
      });
      return ok ? cb(null, true) : cb(new Error('CORS blocked: ' + origin));
    } catch {
      return cb(new Error('CORS blocked: ' + origin));
    }
  },
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
};

app.use(express.json({ limit: '256kb' }));
app.use(cors(corsOptions));
// preflight helper
app.options('*', cors(corsOptions));

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

// === Chat API
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

// === HTTP + WS
const server = app.listen(PORT, () => {
  console.log(`[BOOT] Port=${PORT} Room=${CHAT_ROOM}`);
  console.log(`[BOOT] CORS whitelist:`, CORS_ORIGIN.length ? CORS_ORIGIN : '(all)');
  console.log(`[BOOT] allow null origin:`, ALLOW_NULL_ORIGIN);
  console.log(`[BOOT] Supabase URL set:`, !!SUPABASE_URL);
  console.log(`[BOOT] Service key set:`, !!SUPABASE_SERVICE_KEY);
});

const wss = new WebSocketServer({ server });
const clients = new Map(); // id -> ws

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) {
    try { if (c.readyState === 1) c.send(msg); } catch {}
  }
}
function sendTo(id, obj) {
  const ws = clients.get(id);
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

wss.on('connection', ws => {
  ws._id = Math.random().toString(16).slice(2);
  clients.set(ws._id, ws);

  // Trimite ID-ul către client (frontend-ul tău așteaptă 'voice-id')
  try { ws.send(JSON.stringify({ type: 'voice-id', data: { id: ws._id } })); } catch {}

  ws.on('close', () => { clients.delete(ws._id); });

  ws.on('message', async buf => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    // chat text
    if (msg?.type === 'send') {
      const row = {
        room: CHAT_ROOM,
        cid: msg.cid || null,
        user: String(msg.user || 'Anon').slice(0,160),
        text: String(msg.text || '').slice(0,4000),
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

    // typing
    if (msg?.type === 'typing') {
      broadcast({ type:'typing', data: { active: !!msg.active, user: msg.user || 'Anon', id: ws._id } });
    }

    // ── semnalizare WebRTC (voice) – passthrough
    if (msg?.type === 'voice-join')  broadcast({ type: 'voice-join',  data: { id: ws._id, user: msg.user || '—' } });
    if (msg?.type === 'voice-leave') broadcast({ type: 'voice-leave', data: { id: ws._id } });
    if (msg?.type === 'voice-mute')  broadcast({ type: 'voice-mute',  data: { id: ws._id, muted: !!msg.muted } });

    if (msg?.type === 'voice-offer')  sendTo(msg.to, { type:'voice-offer',  data:{ from: ws._id, sdp: msg.sdp } });
    if (msg?.type === 'voice-answer') sendTo(msg.to, { type:'voice-answer', data:{ from: ws._id, sdp: msg.sdp } });
    if (msg?.type === 'voice-ice')    sendTo(msg.to, { type:'voice-ice',    data:{ from: ws._id, candidate: msg.candidate } });
  });
});
