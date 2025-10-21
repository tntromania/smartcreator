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
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    ts    INTEGER NOT NULL,
    user  TEXT    NOT NULL,
    text  TEXT    NOT NULL
  );
`);

// === App / HTTP ===========================================
const app = express();

// IMPORTANT: pe Render/Netlify/Heroku e în spatele unui proxy -> setează trust proxy
app.set("trust proxy", 1); // <- asta elimină ValidatonError din express-rate-limit

app.use(cors({ origin: "*"}));
app.use(express.json({ limit: "256kb" }));

// rate limiter blând (pe IP)
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  // (opțional) poți forța IP-ul folosit:
  keyGenerator: (req/*, res*/) => req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown"
}));

// Healthcheck simplu
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// (opțional) servește static (dacă pui index.html în /public)
// import.meta.url este ESM; dacă nu vrei static, comentează 2 linii de mai jos
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// --- API REST ---
app.get("/api/history", async (_req, res) => {
  try {
    const rows = await db.all(
      "SELECT ts, user, text FROM messages ORDER BY id DESC LIMIT 200"
    );
    // întoarce cronologic
    res.json(rows.reverse());
  } catch (e) {
    console.error("DB history error:", e);
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
    console.error("POST /api/send error:", e);
    return res.status(500).json({ ok:false, error:"fail" });
  }
});

const PORT = process.env.PORT || 10000;
const server = http.createServer(app);

// === WebSocket (chat live + typing + voice signaling) =====
const wss = new WebSocketServer({ server });

/** id -> ws */
const peers = new Map();

// heartbeat (curățare clienți morți)
function heartbeat() { this.isAlive = true; }

// broadcast utilitar
function broadcast(obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const [id, ws] of peers) {
    if (ws.readyState !== 1) continue;
    if (exceptId && id === exceptId) continue;
    try { ws.send(msg); } catch {}
  }
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  ws._scUser = null; // userul (email) salvat la voice-join
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  peers.set(id, ws);
  // trimite ID-ul propriu (necesar pentru WebRTC mesh)
  ws.send(JSON.stringify({ type:"voice-id", data:{ id } }));

  ws.on("close", ()=> {
    peers.delete(id);
    broadcast({ type:"voice-leave", data:{ id } }, id);
  });

  ws.on("message", async (raw) => {
    let payload; 
    try { payload = JSON.parse(String(raw)); } catch { return; }

    // === CHAT: send din WS (opțional; tu trimiți și prin REST) ===
    if (payload?.type === "send") {
      let user = String(payload.user || "").trim() || "Anon";
      let text = String(payload.text || "").trim();
      if (!text) return;

      user = user.slice(0, 120);
      text = text.slice(0, 2000);
      const ts = Date.now();

      try {
        await db.run("INSERT INTO messages (ts,user,text) VALUES (?,?,?)", ts, user, text);
      } catch (e) {
        console.error("DB insert ws send error:", e);
      }

      broadcast({ type:"message", data:{ ts, user, text }});
      return;
    }

    // === TYPING: folosește "active" (nu "on") ===
    if (payload?.type === "typing") {
      const active = !!(payload.active ?? payload.on ?? false); // compat vechi
      const user = String(payload.user || ws._scUser || "—").slice(0, 120);
      broadcast({ type:"typing", data:{ id, user, active } }, id);
      return;
    }

    // === VOICE: presence & mute ===
    if (payload?.type === "voice-join") {
      ws._scUser = String(payload.user || '').slice(0,120) || null;
      broadcast({ type:"voice-join", data:{ id, user: ws._scUser || '—' } }, id);
      return;
    }

    if (payload?.type === "voice-leave") {
      broadcast({ type:"voice-leave", data:{ id } }, id);
      return;
    }

    if (payload?.type === "voice-mute") {
      const muted = !!payload.muted;
      broadcast({ type:"voice-mute", data:{ id, muted } }, id);
      return;
    }

    // === WebRTC signaling passthrough (offer/answer/ice) ===
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

// ping/pong la 30s ca să închidem conexiunile „moarte”
const interval = setInterval(() => {
  for (const [id, ws] of peers) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      peers.delete(id);
      broadcast({ type:"voice-leave", data:{ id } }, id);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30_000);

wss.on("close", () => clearInterval(interval));

server.listen(PORT, () => {
  console.log("Chat server on :"+PORT);
});
