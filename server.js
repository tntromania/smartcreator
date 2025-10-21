// Chat + Voice WebRTC signaling + Typing + History (SQLite) — API + WS only

import express from "express";
import http from "http";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

// === SQLite (persistență mesaje)
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const db = await open({
  filename: path.join(__dirname, "chat.db"),
  driver: sqlite3.Database,
});
await db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    ts    INTEGER NOT NULL,
    user  TEXT    NOT NULL,
    text  TEXT    NOT NULL
  );
`);

const app = express();
app.set("trust proxy", 1);

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "256kb" }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  keyGenerator: (req) => req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown"
}));

// health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// REST: history
app.get("/api/history", async (_req, res) => {
  try {
    const rows = await db.all("SELECT ts,user,text FROM messages ORDER BY id DESC LIMIT 200");
    res.json(rows.reverse());
  } catch (e) {
    console.error("history fail", e);
    res.status(500).json({ error: "db_fail" });
  }
});

// REST: send
app.post("/api/send", async (req, res) => {
  try {
    let user = String(req.body?.user || "Anon").trim().slice(0, 120);
    let text = String(req.body?.text || "").trim().slice(0, 2000);
    if (!text) return res.status(400).json({ ok: false, error: "empty" });
    const ts = Date.now();
    await db.run("INSERT INTO messages (ts,user,text) VALUES (?,?,?)", ts, user, text);
    broadcast({ type: "message", data: { ts, user, text } });
    res.json({ ok: true });
  } catch (e) {
    console.error("send fail", e);
    res.status(500).json({ ok: false, error: "fail" });
  }
});

const PORT = process.env.PORT || 10000;
const server = http.createServer(app);

// === WebSocket: chat + typing + WebRTC signaling
const wss = new WebSocketServer({ server });
const peers = new Map(); // id -> ws

function broadcast(obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const [id, ws] of peers) {
    if (ws.readyState !== 1) continue;
    if (exceptId && id === exceptId) continue;
    try { ws.send(msg); } catch {}
  }
}
function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  ws._scUser = null;
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  peers.set(id, ws);
  ws.send(JSON.stringify({ type: "voice-id", data: { id } }));

  ws.on("close", () => {
    peers.delete(id);
    broadcast({ type: "voice-leave", data: { id } }, id);
  });

  ws.on("message", async (raw) => {
    let payload; try { payload = JSON.parse(String(raw)); } catch { return; }

    // chat via WS (opțional)
    if (payload?.type === "send") {
      let user = String(payload.user || "Anon").trim().slice(0, 120);
      let text = String(payload.text || "").trim().slice(0, 2000);
      if (!text) return;
      const ts = Date.now();
      try { await db.run("INSERT INTO messages (ts,user,text) VALUES (?,?,?)", ts, user, text); } catch {}
      broadcast({ type: "message", data: { ts, user, text } });
      return;
    }

    // typing (cheie unificată: active)
    if (payload?.type === "typing") {
      const active = !!(payload.active ?? payload.on ?? false);
      const user   = String(payload.user || ws._scUser || "—").slice(0, 120);
      broadcast({ type: "typing", data: { id, user, active } }, id);
      return;
    }

    // voice presence
    if (payload?.type === "voice-join") {
      ws._scUser = String(payload.user || "").slice(0, 120) || null;
      broadcast({ type: "voice-join", data: { id, user: ws._scUser || "—" } }, id);
      return;
    }
    if (payload?.type === "voice-leave") {
      broadcast({ type: "voice-leave", data: { id } }, id);
      return;
    }
    if (payload?.type === "voice-mute") {
      broadcast({ type: "voice-mute", data: { id, muted: !!payload.muted } }, id);
      return;
    }

    // WebRTC signaling passthrough
    if (payload?.type === "voice-offer" || payload?.type === "voice-answer" || payload?.type === "voice-ice") {
      const to = String(payload.to || "");
      const target = peers.get(to);
      if (target && target.readyState === 1) {
        target.send(JSON.stringify({
          type: payload.type,
          data: { from: id, sdp: payload.sdp || null, candidate: payload.candidate || null }
        }));
      }
      return;
    }
  });
});

// curățare conexiuni moarte
const interval = setInterval(() => {
  for (const [id, ws] of peers) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      peers.delete(id);
      broadcast({ type: "voice-leave", data: { id } }, id);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30_000);
wss.on("close", () => clearInterval(interval));

server.listen(PORT, () => {
  console.log("Chat server on :" + PORT);
});
