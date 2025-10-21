// server.js
// Chat + Voice WebRTC signaling + Typing + History (SQLite) — all-in-one
// + servește index.html DIRECT din memorie (fără fișier pe disc)

import express from "express";
import http from "http";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { WebSocketServer } from "ws";
import crypto from "crypto";

// === SQLite (persistență mesaje) ==========================
import sqlite3 from "sqlite3";
import { open } from "sqlite";

// ------------ AICI ȚINEM HTML-UL ÎN MEMORIE ----------------
// Lipeste TOT index.html-ul tău între backtick-uri (`...`).
// Dacă ai resurse mari (BG.jpg, video), folosește URL-uri absolute (CDN / Supabase Storage / Drive).
const INDEX_HTML = /* html */ `<!DOCTYPE html>
<!-- PASTE INDEX.HTML AICI (TOT ce mi-ai dat) -->
`;
// -----------------------------------------------------------

const db = await open({
  filename: "./chat.db",
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

const app = express();
app.set("trust proxy", 1); // necesar pe Render/alte proxie-uri

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "256kb" }));

// rate limit blând
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  keyGenerator: (req) =>
    req.ip ||
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown"
}));

// Healthcheck
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ====== API: istoricul de chat ======
app.get("/api/history", async (_req, res) => {
  try {
    const rows = await db.all(
      "SELECT ts, user, text FROM messages ORDER BY id DESC LIMIT 200"
    );
    res.json(rows.reverse());
  } catch (e) {
    console.error("DB history error:", e);
    res.status(500).json({ error: "db_fail" });
  }
});

// ====== API: trimite mesaj (și broadcast) ======
app.post("/api/send", async (req, res) => {
  try {
    let user = String(req.body?.user || "").trim() || "Anon";
    let text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "empty" });

    user = user.slice(0, 120);
    text = text.slice(0, 2000);

    const ts = Date.now();
    await db.run("INSERT INTO messages (ts,user,text) VALUES (?,?,?)", ts, user, text);

    broadcast({ type: "message", data: { ts, user, text } });
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/send error:", e);
    res.status(500).json({ ok: false, error: "fail" });
  }
});

// ====== SERVEȘTE INDEX DIN MEMORIE ======
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(INDEX_HTML);
});

// (bonus) și /index.html, dacă îl accesezi direct
app.get("/index.html", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(INDEX_HTML);
});

// ====== WebSocket (chat live + typing + voice signaling) ======
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** id -> ws */
const peers = new Map();

function broadcast(obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const [id, ws] of peers) {
    if (ws.readyState !== 1) continue;
    if (exceptId && id === exceptId) continue;
    try { ws.send(msg); } catch {}
  }
}

// heartbeat pentru curățare conexiuni moarte
function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  ws._scUser = null; // userul (email) salvat la voice-join
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  peers.set(id, ws);

  // trimite ID-ul propriu (pentru WebRTC mesh)
  ws.send(JSON.stringify({ type: "voice-id", data: { id } }));

  ws.on("close", () => {
    peers.delete(id);
    broadcast({ type: "voice-leave", data: { id } }, id);
  });

  ws.on("message", async (raw) => {
    let payload;
    try { payload = JSON.parse(String(raw)); } catch { return; }

    // === CHAT prin WS (opțional; ai și REST) ===
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

      broadcast({ type: "message", data: { ts, user, text } });
      return;
    }

    // === TYPING (folosim "active") ===
    if (payload?.type === "typing") {
      const active = !!(payload.active ?? payload.on ?? false); // compat vechi
      const user = String(payload.user || ws._scUser || "—").slice(0, 120);
      broadcast({ type: "typing", data: { id, user, active } }, id);
      return;
    }

    // === VOICE presence/mute ===
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
      const muted = !!payload.muted;
      broadcast({ type: "voice-mute", data: { id, muted } }, id);
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

// ping/pong la 30s
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

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("[BOOT] Listening on " + PORT);
});
