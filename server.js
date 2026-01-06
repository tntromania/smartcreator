require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const webpush = require('web-push');
const Stripe = require('stripe');

/* ========= 1. CONFIGURARE & ENV ========= */
const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const CHAT_ROOM = process.env.CHAT_ROOM || 'global';
// 🔑 Cheia RapidAPI (yt-api)
const RAPID_API_KEY = process.env.RAPIDAPI_KEY || '7efb2ec2c9msh9064cf9c42d6232p172418jsn9da8ae5664d3';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[FATAL] Lipsesc SUPABASE_URL / SUPABASE_SERVICE_KEY');
  // process.exit(1); 
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

/* ========= 2. MIDDLEWARE & CORS ========= */
const DEFAULT_ALLOW_ORIGINS = [
  'https://smartcreator.ro',
  'https://www.smartcreator.ro',
  'http://localhost:5173',
  '*.netlify.app',
];

const RAW_ALLOW = (process.env.CORS_ORIGIN && process.env.CORS_ORIGIN.trim().length
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_ALLOW_ORIGINS
);

const ALLOW_NULL_ORIGIN = String(process.env.ALLOW_NULL_ORIGIN ?? '1').trim() === '1';

function originAllowed(origin) {
  if (!origin || origin === 'null') return ALLOW_NULL_ORIGIN;
  let host = ''; try { host = new URL(origin).hostname; } catch { return false; }
  return RAW_ALLOW.some(patRaw => {
    let pat = patRaw; try { pat = new URL(patRaw).hostname; } catch {}
    if (!pat) return false;
    if (pat === '*') return true;
    if (pat.startsWith('*.')) return host === pat.slice(2) || host.endsWith(pat.slice(1));
    return host === pat;
  });
}

const corsOpts = {
  origin(origin, cb) {
    if (originAllowed(origin)) return cb(null, true);
    console.warn('[CORS] blocked:', origin);
    return cb(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-rapidapi-key', 'x-rapidapi-host']
};

app.use(cors(corsOpts));

// Stripe webhook (raw body)
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
// Restul rutelor (JSON)
app.use(express.json({ limit: '512kb' }));


/* ========= 3. RUTE STRIPE ========= */
const PRICE_TO_PLAN = {}; // Configurați planurile aici dacă e cazul

async function stripeWebhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe] signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const data = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': await handleCheckoutCompleted(data); break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': await handleSubscriptionUpdated(data, event.type); break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] handler error:', err);
    res.status(500).send('Webhook handler error');
  }
}

async function handleCheckoutCompleted(session) {
  const email = (session.customer_details && session.customer_details.email) || session.customer_email;
  if (!email) return;
  const customerId = session.customer;
  const mode = session.mode;
  let priceId = null;
  try {
    const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items.data.price'] });
    priceId = full?.line_items?.data?.[0]?.price?.id || null;
  } catch (e) {}
  const plan = PRICE_TO_PLAN[priceId] || null;
  
  const { data: existing } = await supa.from('profiles').select('user_id, lifetime_access').eq('email', email).maybeSingle();
  const update = { stripe_customer_id: customerId, stripe_price_id: priceId, access_plan: plan, is_active: true };
  if (plan === 'lifetime') update.lifetime_access = true;
  if (mode === 'subscription' && session.subscription) update.stripe_subscription_id = session.subscription;

  if (existing && existing.user_id) {
    await supa.from('profiles').update(update).eq('user_id', existing.user_id);
  } else {
    await supa.from('profiles').insert({ email, ...update });
  }
}

async function handleSubscriptionUpdated(subscription, eventType) {
  const customerId = subscription.customer;
  const status = subscription.status;
  const isActive = status === 'active' || status === 'trialing';
  const periodEndIso = subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null;
  const cancelAtPeriodEnd = !!subscription.cancel_at_period_end || eventType === 'customer.subscription.deleted';

  const { data: profiles } = await supa.from('profiles').select('user_id, lifetime_access').eq('stripe_customer_id', customerId);
  if (!profiles) return;

  for (const p of profiles) {
    const shouldBeActive = p.lifetime_access ? true : isActive;
    await supa.from('profiles').update({ 
      is_active: shouldBeActive, 
      stripe_subscription_id: subscription.id, 
      abo_expires_at: periodEndIso, 
      abo_cancel_at_period_end: cancelAtPeriodEnd 
    }).eq('user_id', p.user_id);
  }
}

app.post('/api/stripe/webhook', stripeWebhookHandler);


/* ========= 4. RUTE PUSH NOTIFICATIONS ========= */
const VAPID_PUBLIC_KEY = 'BMWwOJ3Zu2Py2zpcp2w0Bb29fiuv0RjOtspRbBoXh_0HxlE_GNgIFrsBiiC02oKzjIDI3dexYPhvkPkkBy7Rq_w';
const VAPID_PRIVATE_KEY = 'zSXJ8rxqL6R21CPlNJsMYMk2JMpWkeHdOAhdmV36Eiw';

webpush.setVapidDetails('mailto:contact@smartcreator.ro', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
let pushSubscriptions = [];

async function savePushSubscription(subscription, user = {}) {
  try {
    await supa.from('push_subscriptions').insert({
      subscription, user_email: user.email, user_id: user.id, created_at: new Date().toISOString()
    });
  } catch (e) {}
}

async function loadPushSubscriptions() {
  const { data } = await supa.from('push_subscriptions').select('*').order('created_at', { ascending: false }).limit(1000);
  if (data) {
    pushSubscriptions = data.map(row => ({ subscription: row.subscription, user: { email: row.user_email, id: row.user_id }, timestamp: new Date(row.created_at) }));
  }
}
loadPushSubscriptions();

app.post('/api/push/subscribe', async (req, res) => {
  const { subscription, user } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'bad-subscription' });
  pushSubscriptions = pushSubscriptions.filter(sub => sub.subscription?.endpoint !== subscription.endpoint);
  pushSubscriptions.push({ subscription, user, timestamp: new Date() });
  savePushSubscription(subscription, user);
  res.json({ ok: true });
});

app.post('/api/push/send', async (req, res) => {
  const { title, body, image, url } = req.body;
  const authToken = req.headers.authorization?.replace('Bearer ', '');
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'smartcreator_admin_2025';
  if (authToken !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const payload = JSON.stringify({ title, body, image, url, icon: 'https://smartcreator.ro/logo3.png' });
  const results = await Promise.all(pushSubscriptions.map(async (sub) => {
    try { await webpush.sendNotification(sub.subscription, payload); return { success: true }; }
    catch (e) { return { success: false }; }
  }));
  res.json({ success: true, sent: results.filter(r => r.success).length });
});


/* ========= 5. RUTE XP & MISSION ========= */
const LEVEL_BASE = Number(process.env.LEVEL_BASE || 130);
const XP_BY_TYPE = { profile_complete: 20, lesson_complete: 15, quiz_pass: 25, chat_message: null, mission_complete: 40, daily_checkin: 15, income_milestone: 60, streak_30: 400, daily_quests_all: 50 };
const XP_COOLDOWN_MS = 15000;
const lastXpGrant = new Map();
const CHAT_XP_CAP_PER_DAY = 120;
const CHAT_MSG_CAP_PER_DAY = 40;
const chatDaily = new Map();

function levelFromXp(xpInt = 0) {
  const B = LEVEL_BASE;
  const xp = Math.max(0, Math.floor(xpInt));
  const lvl = 1 + Math.floor(Math.sqrt(xp / B));
  return { level: lvl, total: xp };
}

async function getUserFromToken(bearerOrRaw){
  const token = (bearerOrRaw || '').replace(/^Bearer\s+/i,'').trim();
  if (!token) return null;
  const { data } = await supa.auth.getUser(token);
  return data?.user || null;
}

async function addXp(uid, delta, type, meta={}){
  const { data } = await supa.rpc('add_xp', { uid, delta, ev_type:type, ev_meta:meta });
  return data;
}

// Helpers pentru Chat XP
const dayOf = () => new Date().toISOString().slice(0,10);
const chatKey = (email) => `${String(email||'Anon').toLowerCase()}|${dayOf()}`;
function xpForMessage(text=''){ return Math.min(2 + Math.floor(Math.max(0, String(text).length - 160) / 180), 6); }
function canGrantChatXp(email, inc){
  const k = chatKey(email);
  const row = chatDaily.get(k) || { xp: 0, count: 0 };
  if (row.xp >= CHAT_XP_CAP_PER_DAY || row.count >= CHAT_MSG_CAP_PER_DAY) return 0;
  const allowed = Math.max(0, Math.min(inc, CHAT_XP_CAP_PER_DAY - row.xp));
  row.xp += allowed; row.count += 1; chatDaily.set(k, row);
  return allowed;
}

app.get('/api/xp/me', async (req,res)=>{
  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error:'unauthorized' });
  const { data: ux } = await supa.from('user_xp').select('xp').eq('user_id', user.id).maybeSingle();
  res.json(levelFromXp(ux?.xp || 0));
});

app.post('/api/xp/earn', async (req,res)=>{
  const { token, type, meta } = req.body;
  const user = await getUserFromToken(token || req.headers.authorization);
  if (!user) return res.status(401).json({ error:'unauthorized' });
  if (type === 'chat_message') return res.status(400).json({ error:'ws-only' });
  const newTotal = await addXp(user.id, XP_BY_TYPE[type] || 10, type, meta);
  res.json({ ok:true, ...levelFromXp(newTotal) });
});

app.get('/api/xp/leaderboard', async (req,res)=>{
  const { data } = await supa.from('profiles').select('user_id,full_name,email,xp').order('xp',{ascending:false}).limit(20);
  res.json(data || []);
});

app.post('/api/missions/complete', async (req, res) => {
  const { token, mission_code } = req.body;
  const user = await getUserFromToken(token || req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  
  // Logică simplificată pentru misiune
  const { data: mission } = await supa.from('missions').select('*').eq('code', mission_code).maybeSingle();
  if (!mission) return res.status(404).json({ error: 'Mission not found' });

  // Add XP
  const newTotal = await addXp(user.id, mission.xp_reward || 40, 'mission_complete', { code: mission_code });
  res.json({ ok: true, level: levelFromXp(newTotal) });
});


/* ========= 6. RUTE CHAT & AFFILIATE ========= */
app.get('/api/history', async (req,res)=>{
  const { data } = await supa.from('chat_messages').select('*').eq('room', CHAT_ROOM).order('ts', { ascending:true }).limit(500);
  res.json(data || []);
});

app.post('/api/send', async (req,res)=>{
  const { user, text } = req.body;
  await supa.from('chat_messages').insert({ room:CHAT_ROOM, user, text, ts:Date.now() });
  res.json({ ok: true });
});

// Affiliate placeholders
app.get('/api/aff/ensure', async (req,res)=> res.json({ aff_code: 'temp' }));
app.get('/api/aff/click', async (req,res)=> res.redirect('https://smartcreator.ro'));
app.get('/api/aff/stats', async (req,res)=> res.json({ clicks: 0 }));


/* =========================================================================
   🔻 7. YOUTUBE DOWNLOADER (RAPIDAPI: YT-API) 🔻
   ========================================================================= */

// Helpers Downloader
function extractVideoId(url) {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
    return match ? match[1] : null;
}

function cleanTranscriptXML(xmlData) {
    if (!xmlData) return '';
    if (!xmlData.includes('<text')) return xmlData;
    return xmlData.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

// Endpoint Info
app.post('/api/yt-download', async (req, res) => {
  const { url } = req.body;
  console.log('[SmartDownloader] URL:', url);

  if (!url) return res.status(400).json({ success: false, error: 'URL lipsă' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ success: false, error: 'Link invalid' });

  try {
      // 1. Get Video Data
      const videoRes = await axios.get('https://yt-api.p.rapidapi.com/dl', {
        params: { id: videoId },
        headers: {
          'x-rapidapi-key': RAPID_API_KEY,
          'x-rapidapi-host': 'yt-api.p.rapidapi.com'
        }
      });

      // 2. Get Transcript
      let transcriptText = null;
      try {
          const subRes = await axios.get('https://yt-api.p.rapidapi.com/subtitles', {
              params: { id: videoId },
              headers: {
                  'x-rapidapi-key': RAPID_API_KEY,
                  'x-rapidapi-host': 'yt-api.p.rapidapi.com'
              }
          });
          if (subRes.data && Array.isArray(subRes.data)) {
             transcriptText = subRes.data.map(line => line.text).join(' ');
          }
      } catch (e) { console.log('Fără transcript:', e.message); }

      const data = videoRes.data;
      if (!data || !data.formats) throw new Error('Nu am primit formate.');

      // 3. Filter Formats
      let validFormats = data.formats
          .filter(f => f.acodec !== 'none' && f.vcodec !== 'none' && f.ext === 'mp4')
          .map(f => ({
              qualityLabel: f.quality_label || f.format_note || 'HD',
              url: f.url,
              size: f.filesize_str || ''
          }));

      validFormats = validFormats.filter((v, i, a) => a.findIndex(t => t.qualityLabel === v.qualityLabel) === i);
      validFormats.sort((a, b) => parseInt(b.qualityLabel) - parseInt(a.qualityLabel));

      if (validFormats.length === 0) {
          validFormats = data.formats.filter(f => f.ext === 'mp4').map(f => ({
              qualityLabel: f.format_note || 'Video',
              url: f.url,
              size: ''
          }));
      }

      res.json({
          success: true,
          title: data.title,
          thumbnail: data.thumbnail,
          duration: data.duration,
          formats: validFormats,
          transcript: transcriptText
      });

  } catch (error) {
      console.error('[Eroare YT-API]:', error.message);
      res.status(500).json({ success: false, error: 'Eroare procesare video.' });
  }
});

// Endpoint Stream Download
app.get('/api/stream-download', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    const title = req.query.title || 'video';
    if (!videoUrl) return res.status(400).send('Lipsă URL');

    const safeTitle = title.replace(/[^a-z0-9\s\-_]/gi, '').trim().substring(0, 50) || 'video';
    res.header('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);
    res.header('Content-Type', 'video/mp4');

    const response = await axios({ method: 'get', url: videoUrl, responseType: 'stream' });
    response.data.pipe(res);
  } catch (error) {
    console.error('[Stream Error]', error.message);
    res.status(500).send('Eroare download.');
  }
});


/* ========= 8. START SERVER (UNIC) ========= */
const server = app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });
const voicePeers = new Map();

wss.on('connection', ws => {
  ws._id = Math.random().toString(16).slice(2);
  ws.on('message', async buf => {
    let msg; try{ msg = JSON.parse(buf.toString()); }catch{ return; }
    
    // Chat logic (simplificat pt claritate)
    if (msg?.type === 'send'){
       const { user, text, cid } = msg;
       await supa.from('chat_messages').insert({ room:CHAT_ROOM, user, text, ts:Date.now() });
       // XP logic here (canGrantChatXp etc.)
       const clients = Array.from(wss.clients);
       clients.forEach(c => c.readyState === 1 && c.send(JSON.stringify({ type:'message', data:{user, text, cid} })));
    }
    
    // Voice logic
    if (msg?.type === 'voice-join'){ voicePeers.set(ws._id, { user:msg.user }); }
    if (msg?.type === 'voice-leave'){ voicePeers.delete(ws._id); }
  });
});