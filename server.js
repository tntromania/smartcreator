// server.js
// Chat + Voice WebRTC signaling + Typing + History (SQLite) — all-in-one

import express from "express";
import http from "http";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

// === SQLite (persistență mesaje) ==========================
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const db = await open({
  filename: path.join(__dirname, "chat.db"),
  driver: sqlite3.Database
});
await db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    user TEXT NOT NULL,
    text TEXT NOT NULL
  )
`);

// === App / HTTP ===========================================
const app = express();
app.set("trust proxy", 1); // ✅ necesar pe Render/Proxy

app.use(cors({ origin: "*"}));
app.use(express.json({ limit: "256kb" }));

// limiter blând
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true
}));

// --- API REST ---
app.get("/api/history", async (_req, res) => {
  try {
    const rows = await db.all(
      "SELECT ts, user, text FROM messages ORDER BY id DESC LIMIT 200"
    );
    // invers pentru cronologic
    res.json(rows.reverse());
  } catch (e) {
    res.status(500).json({ error: "db_fail" });
  }
});

app.post("/api/send", async (req, res) => {
  try {
    let user = String(req.body?.user || "").trim();
    let text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok:false, error: "empty" });
    if (!user) user = "Anon";
    user = user.slice(0, 120);
    text = text.slice(0, 2000);

    const ts = Date.now();
    await db.run("INSERT INTO messages (ts,user,text) VALUES (?,?,?)", ts, user, text);

    broadcast({ type:"message", data:{ ts, user, text }});
    return res.json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"fail" });
  }
});

const PORT = process.env.PORT || 10000;
const server = http.createServer(app);

// === WebSocket (chat live + typing + voice signaling) =====
const wss = new WebSocketServer({ server });

/** id -> ws */
const peers = new Map();

function broadcast(obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const [id, ws] of peers) {
    if (ws.readyState !== 1) continue;
    if (exceptId && id === exceptId) continue;
    ws.send(msg);
  }
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  ws._scUser = null; // atașăm userul curent (din voice-join)
  peers.set(id, ws);
  ws.send(JSON.stringify({ type:"voice-id", data:{ id } }));

  ws.on("close", ()=> {
    peers.delete(id);
    broadcast({ type:"voice-leave", data:{ id } });
  });

  ws.on("message", (raw) => {
    let payload; try { payload = JSON.parse(String(raw)); } catch { return; }

    // ... (send, typing rămân la fel)

    if (payload?.type === "voice-join") {
      // memorează user (din client)
      ws._scUser = String(payload.user || '').slice(0,120) || null;
      broadcast({ type:"voice-join", data:{ id, user: ws._scUser || '—' } });
      return;
    }

    if (payload?.type === "voice-leave") {
      broadcast({ type:"voice-leave", data:{ id } });
      return;
    }

    if (payload?.type === "voice-mute") {
      const muted = !!payload.muted;
      broadcast({ type:"voice-mute", data:{ id, muted } });
      return;
    }

    // signaling passthrough (offer/answer/ice) — neschimbat
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

server.listen(PORT, () => {
  console.log("Chat server on :"+PORT);
});
