require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;
const CHAT_ROOM = process.env.CHAT_ROOM || 'global';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Lipsesc SUPABASE_URL sau SUPABASE_SERVICE_KEY in env.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const app = express();

// CORS permis (din env sau toate in dev)
let corsOrigins = true;
if (process.env.CORS_ORIGIN && process.env.CORS_ORIGIN.trim().length) {
  corsOrigins = process.env.CORS_ORIGIN.split(',').map(s => s.trim());
}
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// --- Helpers ---
function nowMs() { return Date.now(); }
function clampText(s, max = 3000) {
  s = String(s || '');
  if (s.length > max) s = s.slice(0, max);
  return s;
}

// --- REST: health ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: nowMs() });
});

// --- REST: history (ultimele N mesaje, ordonate ASC) ---
app.get('/api/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '300', 10), 1000);

    const { data, error } = await supabase
      .from('chat_messages')
      .select('cid,user,text,ts')
      .eq('room', CHAT_ROOM)
      .order('ts', { ascending: true })
      .limit(limit);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('GET /api/history error:', err);
    res.status(500).json([]);
  }
});

// --- REST: send (fallback cand WS nu e disponibil) ---
app.post('/api/send', async (req, res) => {
  try {
    const cid = String(req.body.cid || '');
    const user = clampText(req.body.user || 'Anon', 200);
    const text = clampText(req.body.text || '', 3000);
    const ts = Number.isFinite(+req.body.ts) ? +req.body.ts : nowMs();
    if (!text.trim()) return res.status(400).json({ ok: false });

    const row = { room: CHAT_ROOM, cid, user, text, ts };
    const { error } = await supabase.from('chat_messages').insert(row);
    if (error) throw error;

    // Broadcast si catre WS-uri (daca sunt conectate)
    broadcastAll({ type: 'message', data: row });

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/send error:', err);
    res.status(500).json({ ok: false });
  }
});

const server = http.createServer(app);

// --- WebSocket ---
const wss = new WebSocketServer({ server });
const clients = new Map(); // id -> { ws, user }

function uid() {
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
}

// fallback pentru Node <19 (daca nu exista globalThis.crypto)
let crypto = globalThis.crypto;
if (!crypto || !crypto.getRandomValues) {
  crypto = require('crypto').webcrypto;
}

function broadcastAll(msgObj, exceptId = null) {
  const payload = JSON.stringify(msgObj);
  for (const [id, c] of clients) {
    if (exceptId && id === exceptId) continue;
    if (c.ws.readyState === 1) c.ws.send(payload);
  }
}

function sendTo(targetId, msgObj) {
  const c = clients.get(targetId);
  if (!c || c.ws.readyState !== 1) return;
  c.ws.send(JSON.stringify(msgObj));
}

// Ping/pong keepalive (ajuta impotriva timeouts)
function heartbeat() { this.isAlive = true; }
setInterval(() => {
  for (const [id, c] of clients) {
    if (c.ws.isAlive === false) {
      try { c.ws.terminate(); } catch {}
      clients.delete(id);
      // anunta voice-leave pentru cei care il aveau in room
      broadcastAll({ type: 'voice-leave', data: { id } });
      continue;
    }
    c.ws.isAlive = false;
    try { c.ws.ping(); } catch {}
  }
}, 25000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  const id = uid();
  clients.set(id, { ws, user: '—' });

  // Trimite id-ul clientului
  try {
    ws.send(JSON.stringify({ type: 'voice-id', data: { id } }));
  } catch {}

  ws.on('message', async (raw) => {
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // tipuri: typing, send, voice-join, voice-leave, voice-mute, voice-offer, voice-answer, voice-ice
    if (msg.type === 'typing') {
      const user = clampText(msg.user || 'Anon', 200);
      clients.get(id).user = user;
      // broadcast la toti (in afara de sine)
      broadcastAll({ type: 'typing', data: { id, active: !!msg.active, user } }, id);
      return;
    }

    if (msg.type === 'send') {
      const user = clampText(msg.user || 'Anon', 200);
      const text = clampText(msg.text || '', 3000);
      const cid = String(msg.cid || '');
      const ts = Number.isFinite(+msg.ts) ? +msg.ts : nowMs();

      if (!text.trim()) return;

      const row = { room: CHAT_ROOM, cid, user, text, ts };
      // persist in Supabase
      try {
        const { error } = await supabase.from('chat_messages').insert(row);
        if (error) console.error('Supabase insert error:', error);
      } catch (e) {
        console.error('Supabase insert exception:', e);
      }

      // broadcast catre toti (inclusiv senderul — front-ul are deja optimistic)
      broadcastAll({ type: 'message', data: row });
      return;
    }

    if (msg.type === 'voice-join') {
      const user = clampText(msg.user || 'Anon', 200);
      clients.get(id).user = user;
      // anunta pe ceilalti
      broadcastAll({ type: 'voice-join', data: { id, user } }, id);
      return;
    }

    if (msg.type === 'voice-leave') {
      broadcastAll({ type: 'voice-leave', data: { id } }, id);
      return;
    }

    if (msg.type === 'voice-mute') {
      const muted = !!msg.muted;
      broadcastAll({ type: 'voice-mute', data: { id, muted } }, id);
      return;
    }

    // WebRTC signaling (targetat)
    if (msg.type === 'voice-offer' && msg.to && msg.sdp) {
      sendTo(msg.to, { type: 'voice-offer', data: { from: id, sdp: msg.sdp } });
      return;
    }
    if (msg.type === 'voice-answer' && msg.to && msg.sdp) {
      sendTo(msg.to, { type: 'voice-answer', data: { from: id, sdp: msg.sdp } });
      return;
    }
    if (msg.type === 'voice-ice' && msg.to && msg.candidate) {
      sendTo(msg.to, { type: 'voice-ice', data: { from: id, candidate: msg.candidate } });
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    // anunta plecarea in voice
    broadcastAll({ type: 'voice-leave', data: { id } });
  });

  ws.on('error', (e) => {
    console.error('WS error:', e?.message || e);
  });
});

server.listen(PORT, () => {
  console.log(`✅ HTTP+WS server pornit pe :${PORT}`);
});
