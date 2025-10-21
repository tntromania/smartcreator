// server.js — mini chat self-hosted
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const PORT = process.env.PORT || 8080;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ==== DB (SQLite local) ====
const db = new Database('./chat.db');
db.pragma('journal_mode = WAL');
db.prepare(`
  CREATE TABLE IF NOT EXISTS messages(
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  )
`).run();

// ==== Helpers ====
app.use(cors()); // permite fetch de pe alt domeniu
app.use(express.json({ limit: '50kb' }));

// Rate limit pentru REST
app.use('/api/', rateLimit({ windowMs: 10_000, max: 60 }));

function sanitizeName(name) {
  return String(name || 'Anon')
    .trim()
    .slice(0, 24)
    .replace(/[^\w\-ăâîșțĂÂÎȘȚ ]/g, '');
}

function sanitizeText(text) {
  return String(text || '').trim().slice(0, 1000);
}

function broadcast(json) {
  const msg = JSON.stringify(json);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

// ==== API ====
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/history', (req, res) => {
  const rows = db
    .prepare('SELECT id,user,text,ts FROM messages ORDER BY ts DESC LIMIT 100')
    .all()
    .reverse();
  res.json(rows);
});

app.post('/api/send', (req, res) => {
  const user = sanitizeName(req.body.user);
  const text = sanitizeText(req.body.text);
  if (!text) return res.status(400).json({ error: 'empty' });

  const msg = { id: crypto.randomUUID(), user, text, ts: Date.now() };
  db.prepare('INSERT INTO messages(id,user,text,ts) VALUES(@id,@user,@text,@ts)').run(msg);
  broadcast({ type: 'message', data: msg });

  res.json({ ok: true, id: msg.id });
});

// ==== WebSocket (live) ====
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (payload?.type !== 'send') return;

    const user = sanitizeName(payload.user);
    const text = sanitizeText(payload.text);
    if (!text) return;

    const msg = { id: crypto.randomUUID(), user, text, ts: Date.now() };
    db.prepare('INSERT INTO messages(id,user,text,ts) VALUES(@id,@user,@text,@ts)').run(msg);
    broadcast({ type: 'message', data: msg });
  });
});

server.listen(PORT, () => {
  console.log('Chat server on :' + PORT);
});
