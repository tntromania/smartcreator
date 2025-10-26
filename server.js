// server.js
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

/* ========= ENV ========= */
const PORT                 = process.env.PORT || 10000;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CHAT_ROOM            = process.env.CHAT_ROOM || 'global';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[FATAL] Lipsesc SUPABASE_URL / SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const app = express();
app.use(express.json({ limit: '512kb' }));

/* ========= CORS ========= */
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_NULL_ORIGIN = String(process.env.ALLOW_NULL_ORIGIN ?? '1').trim() === '1';

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === 'null') return ALLOW_NULL_ORIGIN || CORS_ORIGIN.includes('*') || CORS_ORIGIN.includes('null');
  if (!CORS_ORIGIN.length) return true;
  if (CORS_ORIGIN.includes('*')) return true;

  let host = '';
  try { host = new URL(origin).hostname; } catch { return false; }

  return CORS_ORIGIN.some(p => {
    try { p = new URL(p).hostname; } catch {}
    if (!p) return false;
    if (p === host) return true;
    if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1));
    if (p.startsWith('*'))  return host.endsWith(p.slice(1));
    return false;
  });
}
const corsDynamic = cors({
  origin(origin, cb){ isAllowedOrigin(origin) ? cb(null,true) : cb(new Error('CORS blocked: ' + origin)); },
  credentials:true,
  methods:['GET','POST','OPTIONS'],
  allowedHeaders:['Content-Type','Authorization']
});
app.use(corsDynamic);
app.options('*', corsDynamic);

/* ========= XP / LEVEL ========= */
/** Bază de nivel mai „greu”: 150 (poți modifica prin ENV LEVEL_BASE=...) */
const LEVEL_BASE = Number(process.env.LEVEL_BASE || 130);

function levelFromXp(xpInt = 0) {
  const B = LEVEL_BASE;
  const xp = Math.max(0, Math.floor(xpInt));
  const lvl = 1 + Math.floor(Math.sqrt(xp / B));
  const prevThreshold = (lvl - 1) * (lvl - 1) * B;
  const nextThreshold = (lvl) * (lvl) * B;
  const cur = xp - prevThreshold;
  const next = nextThreshold - prevThreshold;
  const pct = Math.max(0, Math.min(100, Math.round((cur / Math.max(1, next)) * 100)));
  return { level: lvl, cur, next, total: xp, pct, prevThreshold, nextThreshold, base: B };
}

/** XP pe acțiuni (tunat) */
const XP_BY_TYPE = {
  profile_complete: 20,
  lesson_complete: 15,
  quiz_pass: 25,
  chat_message: null, // doar prin WS / /api/send
};

const XP_COOLDOWN_MS = 15_000; // 15s între granturi de chat pentru același user (există deja)
const lastXpGrant = new Map();  // email -> last_ts

/** CAP zilnic pentru chat */
const CHAT_XP_CAP_PER_DAY   = 120; // XP maxim din chat / zi / user
const CHAT_MSG_CAP_PER_DAY  = 40;  // mesaje/zi care pot da XP
const chatDaily             = new Map(); // cheie "email|YYYY-MM-DD" -> { xp, count }
const dayOf                 = () => new Date().toISOString().slice(0,10);
const chatKey               = (email) => `${String(email||'Anon').toLowerCase()}|${dayOf()}`;

/** Helpers Supabase */
async function getUserFromToken(bearerOrRaw){
  const token = (bearerOrRaw || '').replace(/^Bearer\s+/i,'').trim();
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}
async function readProfileByEmail(email){
  const { data, error } = await supa
    .from('profiles')
    .select('user_id,email,full_name,level,xp')
    .eq('email', email)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}
async function addXp(uid, delta, type, meta={}){
  const { data, error } = await supa.rpc('add_xp', { uid, delta, ev_type:type, ev_meta:meta });
  if (error){
    const msg = String(error.message||'').toLowerCase();
    if (msg.includes('duplicate') || msg.includes('unique')){
      const { data: ux } = await supa.from('user_xp').select('xp').eq('user_id', uid).maybeSingle();
      return ux?.xp ?? null;
    }
    throw error;
  }
  return data;
}

/** Calculează XP per mesaj: 2–6 XP, cu mic bonus pe mesaje mai lungi */
function xpForMessage(text=''){
  const len = String(text).trim().length;
  const base = 2;
  const bonus = Math.floor(Math.max(0, len - 160) / 180);
  return Math.min(base + bonus, 6);
}

/** Aplică cap-ul zilnic pentru chat; returnează cât XP e „allowable” din `inc` */
function canGrantChatXp(email, inc){
  const k = chatKey(email);
  const row = chatDaily.get(k) || { xp: 0, count: 0 };
  if (row.xp >= CHAT_XP_CAP_PER_DAY || row.count >= CHAT_MSG_CAP_PER_DAY) return 0;
  const allowed = Math.max(0, Math.min(inc, CHAT_XP_CAP_PER_DAY - row.xp));
  row.xp += allowed;
  row.count += 1;
  chatDaily.set(k, row);
  return allowed;
}

/* ================== ROUTES ================== */
app.get('/healthz', (req,res)=>{
  res.json({
    ok:true,
    room:CHAT_ROOM,
    cors:CORS_ORIGIN.length?CORS_ORIGIN:'(all)',
    allow_null_origin:ALLOW_NULL_ORIGIN,
    supa_url:!!SUPABASE_URL,
    service_key:!!SUPABASE_SERVICE_KEY,
    level_base: LEVEL_BASE,
    chat_caps: { CHAT_XP_CAP_PER_DAY, CHAT_MSG_CAP_PER_DAY }
  });
});

/* ---------- XP API ---------- */
app.get('/api/xp/me', async (req,res)=>{
  try{
    const user = await getUserFromToken(req.headers.authorization||'');
    if (!user) return res.status(401).json({ error:'unauthorized' });
    const { data: ux } = await supa.from('user_xp').select('xp').eq('user_id', user.id).maybeSingle();
    const total = ux?.xp || 0;
    res.json(levelFromXp(total));
  }catch(e){ console.error('[xp/me]', e?.message||e); res.status(500).json({ error:'xp-me-failed' }); }
});
app.post('/api/xp/earn', async (req,res)=>{
  try{
    const { token, type, meta={} } = req.body || {};
    const user = await getUserFromToken(token || req.headers.authorization || '');
    if (!user) return res.status(401).json({ error:'unauthorized' });
    if (!type || !(type in XP_BY_TYPE)) return res.status(400).json({ error:'bad-type' });
    if (type === 'chat_message') return res.status(400).json({ error:'chat-message-via-ws-only' });
    const newTotal = await addXp(user.id, XP_BY_TYPE[type], type, meta);
    res.json({ ok:true, ...levelFromXp(newTotal||0) });
  }catch(e){ console.error('[xp/earn]', e?.message||e); res.status(500).json({ error:'xp-earn-failed' }); }
});
app.get('/api/xp/leaderboard', async (req,res)=>{
  try{
    const period = String(req.query.period || 'all').toLowerCase();
    if (period === 'all'){
      const { data, error } = await supa
        .from('profiles')
        .select('user_id, full_name, email, xp')
        .order('xp', { ascending:false })
        .limit(20);
      if (error) throw error;
      return res.json((data||[]).map(r=>({
        user_id:r.user_id,
        full_name:r.full_name || (r.email?r.email.split('@')[0]:'User'),
        email:r.email,
        xp:Math.max(0, r.xp||0)
      })));
    }
    const map = { '7d':'7 days', '30d':'30 days', '24h':'24 hours' };
    const span = map[period] || '7 days';
    const since = new Date(Date.now() - (span.includes('hours') ? 24*60*60*1000 : 7*24*60*60*1000));
    const { data, error } = await supa.rpc('xp_leaderboard', { since: since.toISOString() });
    if (error) throw error;
    res.json(data||[]);
  }catch(e){ console.error('[xp/leaderboard]', e?.message||e); res.status(500).json({ error:'xp-leaderboard-failed' }); }
});

/* ---------- Chat API ---------- */
app.get('/api/history', async (req,res)=>{
  try{
    const { data, error } = await supa
      .from('chat_messages')
      .select('cid,user,text,ts,room')
      .eq('room', CHAT_ROOM)
      .order('ts', { ascending:true })
      .limit(500);
    if (error) return res.status(500).json({ error:error.message });

    const emails = [...new Set((data||[]).map(r=>r.user).filter(Boolean))];
    const meta = new Map();
    if (emails.length){
      const q = await supa.from('profiles').select('email,full_name,level').in('email', emails);
      if (!q.error && Array.isArray(q.data)){
        for (const r of q.data) meta.set(r.email, { name:r.full_name || r.email, level:r.level || 1 });
      }
    }
    const shaped = (data||[]).map(r=>{
      const m = meta.get(r.user);
      return { cid:r.cid, user:m?.name||r.user, level:m?.level||1, text:r.text, ts:r.ts, room:r.room };
    });
    res.json(shaped);
  }catch(e){ console.error('[history]', e); res.status(500).json({ error:'history-failed' }); }
});

app.post('/api/send', async (req,res)=>{
  try{
    const { user: email, name, text, cid, ts } = req.body || {};
    const row = {
      room:CHAT_ROOM,
      cid:cid||null,
      user:String(email||'Anon').slice(0,160),
      text:String(text||'').slice(0,4000),
      ts:Number(ts||Date.now())
    };
    const ins = await supa.from('chat_messages').insert(row);
    if (ins.error) return res.status(500).json({ error:ins.error.message });

    let displayName = name || email;
    let displayLevel = 1;
    try{
      const last = lastXpGrant.get(email) || 0;
      if (Date.now() - last >= XP_COOLDOWN_MS){
        lastXpGrant.set(email, Date.now());
        const prof = await readProfileByEmail(email);
        if (prof?.user_id){
          const rawInc = xpForMessage(text);
          const inc    = canGrantChatXp(email, rawInc);
          if (inc > 0) {
            const total  = await addXp(prof.user_id, inc, 'chat_message', { cid:cid||null });
            const shaped = levelFromXp(total||0);
            displayLevel = shaped.level;
            displayName  = prof.full_name || email;
          } else {
            displayLevel = prof?.level || 1;
            displayName  = prof?.full_name || email;
          }
        }
      } else {
        const prof = await readProfileByEmail(email);
        displayLevel = prof?.level || 1;
        displayName  = (prof?.full_name || name || email);
      }
    }catch(e){ console.error('[XP chat]', e?.message||e); }

    broadcast({ type:'message', data:{ ...row, user:displayName, level:displayLevel } });
    res.json({ ok:true });
  }catch(e){ console.error('[send]', e); res.status(500).json({ error:'send-failed' }); }
});

/* ---------- AFFILIATE API ---------- */
// Folosește tabelul tău: "affiliates" (user_id UNIQUE, aff_code UNIQUE)
async function genUniqueCode(){
  for (let i=0;i<6;i++){
    const c = crypto.randomBytes(4).toString('base64url').replace(/[^a-zA-Z0-9]/g,'').slice(0,7);
    const { data } = await supa.from('affiliates').select('aff_code').eq('aff_code', c).maybeSingle();
    if (!data) return c.toLowerCase();
  }
  return crypto.randomUUID().slice(0,8);
}
app.get('/api/aff/ensure', async (req,res)=>{
  try{
    const user = await getUserFromToken(req.headers.authorization||'');
    if (!user) return res.status(401).json({ error:'unauthorized' });

    const { data: existing } = await supa
      .from('affiliates')
      .select('aff_code')
      .eq('user_id', user.id)
      .maybeSingle();

    if (existing?.aff_code) return res.json({ aff_code: existing.aff_code });

    const code = await genUniqueCode();
    const ins = await supa.from('affiliates').insert({ user_id:user.id, aff_code:code });
    if (ins.error) return res.status(500).json({ error:ins.error.message });

    res.json({ aff_code: code });
  }catch(e){ console.error('[aff/ensure]', e?.message||e); res.status(500).json({ error:'aff-ensure-failed' }); }
});

// Track click + redirect 302
app.get('/api/aff/click', async (req, res) => {
  try {
    const aff_code = String(req.query.aff_code || '').trim().toLowerCase();
    const landing_url_raw = String(req.query.u || '').trim();

    if (!aff_code) return res.status(400).json({ ok: false });

    const { data: ex } = await supa
      .from('affiliates')
      .select('aff_code')
      .eq('aff_code', aff_code)
      .maybeSingle();
    if (!ex) return res.status(404).json({ ok: false });

    const ip  = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .toString().split(',')[0].trim();
    const ua  = String(req.headers['user-agent'] || '');
    const ref = String(req.headers['referer'] || '');
    const day = new Date().toISOString().slice(0, 10);
    const ipHash = crypto.createHash('sha256')
      .update(aff_code + '|' + ip + '|' + ua + '|' + day)
      .digest('hex')
      .slice(0, 32);

    try {
      await supa.from('affiliate_clicks').insert({
        aff_code,
        landing_url: landing_url_raw,
        referer: ref.slice(0, 500),
        ua: ua.slice(0, 400),
        ip_hash: ipHash,
        day
      });
    } catch (err) {
      console.error('[aff/click] insert failed:', err);
    }

    const FALLBACK = 'https://smartcreator.ro/';
    const allowedHosts = new Set(['smartcreator.ro', 'www.smartcreator.ro']);
    let dest = FALLBACK;

    try {
      const u = new URL(landing_url_raw || FALLBACK);
      if (!allowedHosts.has(u.hostname)) throw new Error('host-not-allowed');
      if (!u.searchParams.get('ref')) u.searchParams.set('ref', aff_code);
      dest = u.toString();
    } catch (_) {
      // rămânem pe FALLBACK
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, dest);
  } catch (e) {
    console.error('[aff/click]', e?.message || e);
    return res.redirect(302, 'https://smartcreator.ro/');
  }
});

// Stats publice (clicks/leads/sales/revenue).
app.get('/api/aff/stats', async (req,res)=>{
  try{
    const aff_code = String(req.query.aff_code||'').trim().toLowerCase();
    if (!aff_code) return res.status(400).json({ error:'no-code' });

    const clicksR = await supa.from('affiliate_clicks')
      .select('id',{ count:'exact', head:true })
      .eq('aff_code', aff_code);
    const clicks  = clicksR.count || 0;

    // dacă pe landing bagi în altă tabelă, schimbă aici
    const leadsR  = await supa.from('waitlist')
      .select('id',{ count:'exact', head:true })
      .eq('ref_by', aff_code);
    const leads   = leadsR.count || 0;

    const salesR = await supa
      .from('affiliate_orders')
      .select('commission_eur,amount_eur')
      .eq('aff_code', aff_code)
      .eq('status','paid');
    const sales   = Array.isArray(salesR.data) ? salesR.data.length : 0;
    const revenue = Array.isArray(salesR.data)
      ? Math.round(salesR.data.reduce((s,r)=> s + (Number(r.commission_eur)||0), 0))
      : 0;

    res.json({ clicks, leads, sales, revenue });
  }catch(e){ console.error('[aff/stats]', e?.message||e); res.status(500).json({ error:'aff-stats-failed' }); }
});

/* ========= WS ========= */
const server = app.listen(PORT, ()=>{
  console.log(`[BOOT] Port=${PORT} Room=${CHAT_ROOM}`);
  console.log(`[BOOT] CORS:`, CORS_ORIGIN.length?CORS_ORIGIN:'(all)');
  console.log(`[BOOT] Allow Origin "null":`, ALLOW_NULL_ORIGIN);
  console.log(`[BOOT] Level base: ${LEVEL_BASE} | Chat caps: ${CHAT_XP_CAP_PER_DAY} XP/zi, ${CHAT_MSG_CAP_PER_DAY} mesaje/zi`);
});
const wss = new WebSocketServer({ server });

function broadcast(obj){
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c=>{ try{ if (c.readyState===1) c.send(msg); }catch{} });
}

const voicePeers = new Map();

wss.on('connection', ws=>{
  ws._id = Math.random().toString(16).slice(2);
  try{ ws.send(JSON.stringify({ type:'voice-id', data:{ id:ws._id } })); }catch{}
  try{
    const list = Array.from(voicePeers, ([id,v])=>({ id, user:v.user, muted:!!v.muted }));
    ws.send(JSON.stringify({ type:'voice-state', data:list }));
  }catch{}

  ws.on('message', async buf=>{
    let msg; try{ msg = JSON.parse(buf.toString()); }catch{ return; }

    if (msg?.type === 'send'){
      const email = String(msg.user||'Anon').slice(0,160);
      const row = { room:CHAT_ROOM, cid:msg.cid||null, user:email, text:String(msg.text||'').slice(0,4000), ts:Date.now() };
      const ins = await supa.from('chat_messages').insert(row);
      if (ins.error){ try{ ws.send(JSON.stringify({ type:'error', error:ins.error.message })); }catch{}; return; }

      let displayName = msg.name || email;
      let displayLevel = 1;
      try{
        const last = lastXpGrant.get(email) || 0;
        if (Date.now() - last >= XP_COOLDOWN_MS){
          lastXpGrant.set(email, Date.now());
          const prof = await readProfileByEmail(email);
          if (prof?.user_id){
            const rawInc = xpForMessage(row.text);
            const inc    = canGrantChatXp(email, rawInc);
            if (inc > 0){
              const total  = await addXp(prof.user_id, inc, 'chat_message', { cid:row.cid||null });
              const shaped = levelFromXp(total||0);
              displayLevel = shaped.level;
              displayName  = prof.full_name || email;
            } else {
              displayLevel = prof?.level || 1;
              displayName  = prof?.full_name || email;
            }
          }
        } else {
          const prof = await readProfileByEmail(email);
          displayLevel = prof?.level || 1;
          displayName  = (prof?.full_name || msg.name || email);
        }
      }catch(e){ console.error('[WS XP chat]', e?.message||e); }

      broadcast({ type:'message', data:{ ...row, user:displayName, level:displayLevel } });
      return;
    }

    if (msg?.type === 'typing'){
      broadcast({ type:'typing', data:{ active:!!msg.active, user:msg.user||'Anon', id:ws._id } });
      return;
    }

    if (msg?.type === 'voice-join'){ voicePeers.set(ws._id, { user:msg.user||'—', muted:false }); broadcast({ type:'voice-join', data:{ id:ws._id, user:msg.user||'—' } }); return; }
    if (msg?.type === 'voice-leave'){ if (voicePeers.has(ws._id)) voicePeers.delete(ws._id); broadcast({ type:'voice-leave', data:{ id:ws._id } }); return; }
    if (msg?.type === 'voice-mute'){ const r=voicePeers.get(ws._id); if (r){ r.muted=!!msg.muted; voicePeers.set(ws._id,r); } broadcast({ type:'voice-mute', data:{ id:ws._id, muted:!!msg.muted } }); return; }
    if (msg?.type === 'voice-offer'){ broadcast({ type:'voice-offer', data:{ from:ws._id, to:msg.to, sdp:msg.sdp } }); return; }
    if (msg?.type === 'voice-answer'){ broadcast({ type:'voice-answer', data:{ from:ws._id, to:msg.to, sdp:msg.sdp } }); return; }
    if (msg?.type === 'voice-ice'){ broadcast({ type:'voice-ice', data:{ from:ws._id, to:msg.to, candidate:msg.candidate } }); return; }
  });

  ws.on('close', ()=>{
    try{
      if (voicePeers.has(ws._id)){ voicePeers.delete(ws._id); broadcast({ type:'voice-leave', data:{ id:ws._id } }); }
    }catch{}
  });
});
