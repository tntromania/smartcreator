// server.js
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import http from "http";
import crypto from "crypto";
import Database from "better-sqlite3";

const PORT = process.env.PORT || 8080;
const app  = express();
app.set('trust proxy', 1); // sau true
app.use(cors());
app.use(express.json());

// DB mic, în fișier (persistă pe Render)
const db = new Database("chat.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages(
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
`);

const sanitize = s => String(s||"").slice(0, 2000);

// REST
app.get("/api/history", (req,res)=>{
  const rows = db.prepare("SELECT id,user,text,ts FROM messages ORDER BY ts ASC LIMIT 500").all();
  res.json(rows);
});

app.post("/api/send", (req,res)=>{
  const user = sanitize(req.body.user);
  const text = sanitize(req.body.text);
  if(!text) return res.status(400).json({ok:false});
  const msg = { id: crypto.randomUUID(), user, text, ts: Date.now() };
  db.prepare("INSERT INTO messages(id,user,text,ts) VALUES(@id,@user,@text,@ts)").run(msg);
  broadcast({ type:"message", data: msg });
  res.json({ ok: true });
});

// HTTP + WS
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const peers = new Map(); // id -> ws

function broadcast(obj){
  const data = JSON.stringify(obj);
  wss.clients.forEach(c => { if(c.readyState===1) c.send(data); });
}

wss.on("connection", (ws) => {
  // atribuie un id de voice pentru fiecare ws (poi folosit în WebRTC)
  const id = crypto.randomUUID();
  peers.set(id, ws);
  ws.send(JSON.stringify({ type:"voice-id", data:{ id } }));

  ws.on("close", ()=> {
    peers.delete(id);
    broadcast({ type:"voice-leave", data:{ id } });
  });

  ws.on("message", (raw) => {
    let payload; try { payload = JSON.parse(String(raw)); } catch { return; }

    // chat text
    if (payload?.type === "send") {
      const user = sanitize(payload.user);
      const text = sanitize(payload.text);
      if (!text) return;
      const msg = { id: crypto.randomUUID(), user, text, ts: Date.now() };
      db.prepare("INSERT INTO messages(id,user,text,ts) VALUES(@id,@user,@text,@ts)").run(msg);
      broadcast({ type:"message", data: msg });
      return;
    }

    // typing indicator (doar broadcast, nu se salvează)
    if (payload?.type === "typing") {
      const user = sanitize(payload.user);
      const active = !!payload.active;
      broadcast({ type:"typing", data:{ user, active, ts: Date.now() } });
      return;
    }

    // --- WebRTC signaling (mesh simplu) ---
    if (payload?.type === "voice-join") {
      broadcast({ type:"voice-join", data:{ id } });
      return;
    }
    if (payload?.type === "voice-leave") {
      broadcast({ type:"voice-leave", data:{ id } });
      return;
    }

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

server.listen(PORT, () => console.log("SmartCreator chat+voice on", PORT));
