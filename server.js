// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const webpush = require('web-push');
const Stripe = require('stripe');

/* ========= ENV ========= */
const PORT                 = process.env.PORT || 10000;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[FATAL] Lipsesc SUPABASE_URL / SUPABASE_SERVICE_KEY');
  process.exit(1);
}

// ✅ o singură dată
const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);


// === STRIPE CONFIG ===
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// mapezi prețurile Stripe -> planurile tale interne
const PRICE_TO_PLAN = {
  // pune aici ID-urile reale de preț din Stripe Dashboard
  // ex: 'prod_SbveE02KhkaRgh' : 'monthly',
  //     'prod_SYexXX9WZJzqEr' : 'yearly',
  //     'prod_SYevGWLebBRXOA' : 'lifetime',
};

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const CHAT_ROOM            = process.env.CHAT_ROOM || 'global';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[FATAL] Lipsesc SUPABASE_URL / SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const app = express();

/* ===== STRIPE WEBHOOK (trebuie înainte de express.json) ===== */
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler
);

// restul API-ului tău folosește JSON normal
app.use(express.json({ limit: '512kb' }));

/* ========= CORS (robust, cu wildcard) ========= */
// Dacă nu setezi CORS_ORIGIN în env, folosește lista implicită de mai jos.
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

// Permite sau nu origini "null" (ex: request-uri din extensii, file://, SW)
const ALLOW_NULL_ORIGIN = String(process.env.ALLOW_NULL_ORIGIN ?? '1').trim() === '1';

function originAllowed(origin) {
  // fără Origin (ex: curl/Postman/SW) — tratează ca "null"
  if (!origin || origin === 'null') return ALLOW_NULL_ORIGIN;

  let host = '';
  try { host = new URL(origin).hostname; } catch { return false; }

  return RAW_ALLOW.some(patRaw => {
    // Acceptă atât URL-uri complete, cât și hostname/wildcard
    let pat = patRaw;
    try { pat = new URL(patRaw).hostname; } catch {} // dacă e URL, extrage hostname

    if (!pat) return false;
    if (pat === '*') return true;
    if (pat.startsWith('*.')) {
      // ex: *.netlify.app -> match pe subdomenii și pe exact netlify.app
      return host === pat.slice(2) || host.endsWith(pat.slice(1));
    }
    if (pat.startsWith('*')) {
      // ex: *netlify.app
      return host.endsWith(pat.slice(1));
    }
    // match exact
    return host === pat;
  });
}

const corsOpts = {
  origin(origin, cb) {
    if (originAllowed(origin)) return cb(null, true);
    console.warn('[CORS] blocked:', origin, 'allowed =', RAW_ALLOW);
    return cb(new Error('CORS blocked'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400, // cache pentru preflight
};

// Ajută la cache corect pe CDN/proxy (ca să nu “piardă” headerul CORS)
app.use((req, res, next) => { res.setHeader('Vary', 'Origin'); next(); });

// Activează CORS global + preflight pentru toate rutele
const corsDynamic = cors(corsOpts);
app.use(corsDynamic);
app.options('*', corsDynamic);
app.options('/api/push/subscribe', corsDynamic);
app.options('/api/push/send', corsDynamic);
app.options('/api/push/subscriptions', corsDynamic);



/* ========= PUSH NOTIFICATIONS ========= */
// Configurează VAPID Keys - CHEILE TALE REALE
const VAPID_PUBLIC_KEY = 'BMWwOJ3Zu2Py2zpcp2w0Bb29fiuv0RjOtspRbBoXh_0HxlE_GNgIFrsBiiC02oKzjIDI3dexYPhvkPkkBy7Rq_w';
const VAPID_PRIVATE_KEY = 'zSXJ8rxqL6R21CPlNJsMYMk2JMpWkeHdOAhdmV36Eiw';

console.log('🔑 VAPID Public Key:', VAPID_PUBLIC_KEY);
console.log('🔐 VAPID Private Key loaded:', VAPID_PRIVATE_KEY ? '✅' : '❌');

webpush.setVapidDetails(
  'mailto:contact@smartcreator.ro',
  VAPID_PUBLIC_KEY,    // Aceeași cheie publică ca în frontend
  VAPID_PRIVATE_KEY    // Cheia ta privată
);

// Stocare subscription-uri push (în memorie - pentru început)
let pushSubscriptions = [];

// POST /api/push/subscribe — primește subscription-ul din browser
app.post('/api/push/subscribe', corsDynamic, async (req, res) => {
  try {
    const { subscription, user } = req.body || {};
    
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'bad-subscription' });
    }

    console.log('📝 New push subscription from:', user?.email || 'unknown');
    console.log('🔗 Endpoint:', subscription.endpoint?.slice(0, 80) + '...');

    // Salvează în memorie
    pushSubscriptions = pushSubscriptions.filter(sub => 
      sub.subscription?.endpoint !== subscription.endpoint
    );
    
    pushSubscriptions.push({ 
      subscription, 
      user, 
      timestamp: new Date() 
    });

    // Încearcă să salvezi și în Supabase
    try {
      await savePushSubscription(subscription, user || {});
    } catch (e) {
      console.warn('Supabase save failed, keeping in memory:', e?.message);
    }

    console.log(`✅ Total subscriptions: ${pushSubscriptions.length}`);
    return res.json({ ok: true, message: 'Subscribed to push notifications' });
    
  } catch (e) {
    console.error('❌ subscribe error:', e);
    res.status(500).json({ error: 'subscribe-failed' });
  }
});

// Funcție pentru a salva subscription-urile în Supabase
async function savePushSubscription(subscription, user = {}) {
  try {
    const { data, error } = await supa
      .from('push_subscriptions')
      .insert({
        subscription: subscription,
        user_email: user.email,
        user_id: user.id,
        created_at: new Date().toISOString()
      })
      .select();
    
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Eroare salvare subscription:', error);
    throw error; // Re-throw pentru a fi prins în funcția apelantă
  }
}

// Funcție pentru a încărca subscription-urile din Supabase
async function loadPushSubscriptions() {
  try {
    const { data, error } = await supa
      .from('push_subscriptions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1000);
    
    if (!error && data) {
      pushSubscriptions = data.map(row => ({
        subscription: row.subscription,
        user: { email: row.user_email, id: row.user_id },
        timestamp: new Date(row.created_at)
      }));
      console.log(`📥 Loaded ${pushSubscriptions.length} subscriptions from Supabase`);
    }
  } catch (error) {
    console.error('Eroare încărcare subscriptions:', error);
  }
}

// POST /api/push/send - Trimite notificări push
app.post('/api/push/send', corsDynamic, async (req, res) => {
  try {
    const { title, body, image, url } = req.body;
    const authToken = req.headers.authorization?.replace('Bearer ', '');

    // Verifică token-ul de admin
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'smartcreator_admin_2025';
    if (authToken !== ADMIN_TOKEN) {
      console.log('❌ Unauthorized push attempt with token:', authToken?.slice(0, 10) + '...');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body required' });
    }

    console.log(`📢 Sending push to ${pushSubscriptions.length} users:`, title);

    const payload = JSON.stringify({
      title: title,
      body: body,
      image: image,
      url: url || 'https://smartcreator.ro/#sec-changelog',
      icon: 'https://smartcreator.ro/logo3.png',
      badge: 'https://smartcreator.ro/logo3.png',
      tag: 'update-' + Date.now()
    });

    // Trimite tuturor
    const results = await Promise.all(
      pushSubscriptions.map(async (sub, index) => {
        try {
          await webpush.sendNotification(sub.subscription, payload);
          console.log(`✅ Sent to ${index + 1}/${pushSubscriptions.length}`);
          return { success: true, index };
        } catch (error) {
          console.log(`❌ Failed ${index + 1}:`, error.statusCode);
          
          // Șterge subscription-uri invalide
          if (error.statusCode === 410 || error.statusCode === 404) {
            pushSubscriptions = pushSubscriptions.filter(s => s !== sub);
            // Șterge și din Supabase
            try {
              await supa.from('push_subscriptions')
                .delete()
                .filter('subscription->>endpoint', 'eq', sub.subscription.endpoint);
            } catch (dbError) {
              console.error('Eroare ștergere subscription:', dbError);
            }
          }
          return { success: false, index, error: error.message };
        }
      })
    );

    const successful = results.filter(r => r.success).length;
    
    console.log(`🎯 Push results: ${successful}/${results.length} successful`);
    
    res.json({ 
      success: true, 
      sent: successful, 
      total: results.length,
      failed: results.length - successful,
      message: `Notificare trimisă la ${successful} utilizatori`
    });

  } catch (error) {
    console.error('❌ Eroare send push:', error);
    res.status(500).json({ error: error.message });
  }
});

// Încarcă subscription-urile la pornire
loadPushSubscriptions().then(() => {
  console.log(`[PUSH] Subscription-uri încărcate: ${pushSubscriptions.length}`);
});

/* ========= XP / LEVEL ========= */
/** Bază de nivel mai „greu”: 150 (poți modifica prin ENV LEVEL_BASE=...) */
const LEVEL_BASE = Number(process.env.LEVEL_BASE || 130);

/* ========= STRIPE WEBHOOK LOGIC ========= */

async function stripeWebhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,                // raw body (mulțumită express.raw)
      sig,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripe] signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const data = event.data.object;

    switch (event.type) {
case 'checkout.session.completed':
  await handleCheckoutCompleted(data);
  break;

// putem trata la fel created/updated/deleted
case 'customer.subscription.created':
case 'customer.subscription.updated':
case 'customer.subscription.deleted':
  await handleSubscriptionUpdated(data, event.type);
  break;

default:
  // alte evenimente nu ne interesează momentan
  break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] handler error:', err);
    res.status(500).send('Webhook handler error');
  }
}

async function handleCheckoutCompleted(session) {
  // email-ul clientului – super important să fie același ca în Supabase
  const email =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    null;

  if (!email) {
    console.warn('[stripe] checkout complet fără email');
    return;
  }

  const customerId = session.customer;
  const mode = session.mode; // 'payment' sau 'subscription'

  // luăm priceId-ul exact de pe session
  let priceId = null;
  try {
    const full = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items.data.price'],
    });
    priceId = full?.line_items?.data?.[0]?.price?.id || null;
  } catch (e) {
    console.error('[stripe] nu pot citi line_items:', e.message);
  }

  const plan = PRICE_TO_PLAN[priceId] || null;

  console.log('✅ checkout.session.completed', { email, plan, priceId, mode });

  // vezi dacă există deja profilul după email
  const { data: existing, error } = await supa
    .from('profiles')
    .select('user_id, lifetime_access')
    .eq('email', email)
    .maybeSingle();

  if (error) {
    console.error('[stripe] read profile error:', error);
  }

  // payload comun pentru update/insert
  const update = {
    stripe_customer_id: customerId,
    stripe_price_id: priceId,
    access_plan: plan,
    is_active: true,
  };

  if (plan === 'lifetime') {
    update.lifetime_access = true;
  }

  if (mode === 'subscription' && session.subscription) {
    update.stripe_subscription_id = session.subscription;
  }

  if (existing && existing.user_id) {
    await supa
      .from('profiles')
      .update(update)
      .eq('user_id', existing.user_id);
  } else {
    await supa
      .from('profiles')
      .insert({
        email,
        ...update,
      });
  }
}

async function handleSubscriptionUpdated(subscription, eventType = 'customer.subscription.updated') {
  const customerId = subscription.customer;
  const status     = subscription.status; // active, trialing, canceled, etc.
  const isActive   = status === 'active' || status === 'trialing';

  // ⏱ data de expirare a perioadei curente din Stripe (UNIX seconds -> ISO)
  const periodEndIso = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  // dacă user-ul a dat „cancel at period end” sau a venit event deleted
  const cancelAtPeriodEnd =
    !!subscription.cancel_at_period_end ||
    eventType === 'customer.subscription.deleted';

  console.log('🔄 subscription update', {
    customerId,
    status,
    eventType,
    periodEndIso,
    cancelAtPeriodEnd,
  });

  const { data: profiles, error } = await supa
    .from('profiles')
    .select('user_id, lifetime_access')
    .eq('stripe_customer_id', customerId);

  if (error) {
    console.error('[stripe] subscription profiles error:', error);
    return;
  }

  if (!profiles || !profiles.length) {
    console.warn('[stripe] niciun profil pentru customer', customerId);
    return;
  }

  for (const p of profiles) {
    // lifetime rămâne activ indiferent de abonament
    const shouldBeActive = p.lifetime_access ? true : isActive;

    const update = {
      is_active: shouldBeActive,
      stripe_subscription_id: subscription.id,
      abo_expires_at: periodEndIso,
      abo_cancel_at_period_end: cancelAtPeriodEnd,
    };

    await supa
      .from('profiles')
      .update(update)
      .eq('user_id', p.user_id);
  }
}


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
  chat_message: null,       // doar prin WS / /api/send
  mission_complete: 40,     // când bifează o misiune săptămânală
  daily_checkin: 15,        // butonul "Am lucrat azi" — 15 XP / zi
  income_milestone: 60,     // când bifează 1$, 10$, 50$, 100$
  streak_30: 400,           // ✅ nou: bonus mare la 30 de zile consecutive
  daily_quests_all: 50,
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

/* ===== VALIDARE MISIUNI (în funcție de ce a făcut userul) ===== */
async function validateMissionProgress(mission, userId) {
  // intervalul în care verificăm progresul misiunii
  const now = new Date();
  const startDate = mission.starts_at ? new Date(mission.starts_at) : new Date('1970-01-01T00:00:00Z');
  const endDate   = mission.ends_at   ? new Date(mission.ends_at)   : now;

  const startIso = startDate.toISOString();
  const endIso   = endDate.toISOString();
  const startTs  = startDate.getTime();
  const endTs    = endDate.getTime();

  /* === MISIUNE: watch_3_lessons -> user trebuie să fi terminat minim 3 lecții === */
  if (mission.code === 'watch_3_lessons') {
    try {
      const { data, error } = await supa
        .from('xp_events')
        .select('meta, created_at')
        .eq('user_id', userId)
        .eq('type', 'lesson_complete')
        .gte('created_at', startIso)
        .lte('created_at', endIso);

      if (error) {
        console.error('[missions] xp_events error', error);
        return { valid: false, reason: 'Nu am putut verifica progresul la lecții. Încearcă din nou mai târziu.' };
      }

      const events = data || [];
      const lessons = new Set(
        events
          .map(ev => (ev.meta && (ev.meta.lesson || ev.meta.lesson_id)))
          .filter(Boolean)
      );

      const count = lessons.size;
      if (count >= 3) {
        return { valid: true };
      }

      return {
        valid: false,
        reason: `Ai doar ${count}/3 lecții terminate în perioada misiunii.`
      };
    } catch (e) {
      console.error('[missions] watch_3_lessons', e?.message || e);
      return { valid: false, reason: 'Eroare la verificarea lecțiilor.' };
    }
  }

  /* === MISIUNE: chat_10_messages -> minim 10 mesaje în chat în perioada misiunii === */
  if (mission.code === 'chat_10_messages') {
    try {
      // luăm email-ul userului ca să-l legăm de chat_messages.user
      const { data: prof, error: pErr } = await supa
        .from('profiles')
        .select('email')
        .eq('user_id', userId)
        .maybeSingle();

      if (pErr || !prof?.email) {
        console.error('[missions] profile for chat', pErr);
        return { valid: false, reason: 'Nu ți-am găsit profilul pentru verificarea mesajelor din chat.' };
      }

      const { data: msgs, error: mErr } = await supa
        .from('chat_messages')
        .select('id, ts')
        .eq('room', CHAT_ROOM)
        .eq('user', prof.email)
        .gte('ts', startTs)
        .lte('ts', endTs);

      if (mErr) {
        console.error('[missions] chat_messages error', mErr);
        return { valid: false, reason: 'Nu am putut verifica mesajele din chat.' };
      }

      const count = (msgs || []).length;
      if (count >= 10) {
        return { valid: true };
      }

      return {
        valid: false,
        reason: `Ai doar ${count}/10 mesaje în chat în perioada misiunii. Scrie câteva mesaje cu sens în chat. 🙂`
      };
    } catch (e) {
      console.error('[missions] chat_10_messages', e?.message || e);
      return { valid: false, reason: 'Eroare la verificarea mesajelor de chat.' };
    }
  }

  // TODO: aici poți adăuga alte misiuni pe viitor (post_3_tiktoks, share_aff_3_friends etc.)

  return {
    valid: false,
    reason: 'Nu există încă validare automată pentru acest tip de misiune.'
  };
}

/* ================== ROUTES ================== */
app.get('/healthz', (req,res)=>{
  res.json({
    ok:true,
    room:CHAT_ROOM,
    cors: RAW_ALLOW,
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
app.post('/api/xp/redeem', async (req, res) => {
  try {
    const { token, reward_id } = req.body || {};
    const user = await getUserFromToken(token || req.headers.authorization || '');
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (!reward_id) return res.status(400).json({ error: 'missing_reward' });

    // 1. Ia recompensa
    const { data: reward, error: rErr } = await supa
      .from('rewards')
      .select('id, code, title, description, cost_xp, active')
      .eq('id', reward_id)
      .maybeSingle();

    if (rErr || !reward || !reward.active) {
      console.warn('[xp/redeem] reward_err', rErr);
      return res.status(404).json({ error: 'reward_not_found' });
    }

    // 2. Verifică dacă nu e deja răscumpărată (dacă vrei one-time per user)
    const { data: already } = await supa
      .from('reward_redemptions')
      .select('id')
      .eq('user_id', user.id)
      .eq('reward_id', reward.id)
      .maybeSingle();

    if (already) {
      return res.status(400).json({ error: 'already_redeemed' });
    }

    // 3. XP curent (din user_xp – e tabela canonică)
    const { data: ux } = await supa
      .from('user_xp')
      .select('xp')
      .eq('user_id', user.id)
      .maybeSingle();

    const currentXp = ux?.xp || 0;
    if (currentXp < reward.cost_xp) {
      return res.status(400).json({ error: 'not_enough_xp', current_xp: currentXp });
    }

    // 4. Scade XP folosind aceleași reguli ca la /xp/earn (delta negativ)
    const newTotal = await addXp(
      user.id,
      -reward.cost_xp,
      'reward_redeem',
      { reward_id: reward.id, code: reward.code, cost_xp: reward.cost_xp }
    );

    // 5. Log în reward_redemptions
    const { error: insErr } = await supa
      .from('reward_redemptions')
      .insert({
        user_id: user.id,
        reward_id: reward.id,
        meta: {}
      });

    if (insErr) {
      console.error('[xp/redeem] insert redemption', insErr);
      return res.status(500).json({ error: 'redemption_failed' });
    }

    return res.json({
      success: true,
      new_xp: newTotal ?? (currentXp - reward.cost_xp),
      reward: {
        id: reward.id,
        code: reward.code,
        title: reward.title,
        description: reward.description,
        cost_xp: reward.cost_xp
      }
    });
  } catch (e) {
    console.error('[xp/redeem]', e?.message || e);
    res.status(500).json({ error: 'xp-redeem-failed' });
  }
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
/* ---------- MISSIONS API ---------- */
app.post('/api/missions/complete', async (req, res) => {
  try {
    const { token, mission_code } = req.body || {};
    const user = await getUserFromToken(token || req.headers.authorization || '');
    if (!user) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!mission_code) {
      return res.status(400).json({ error: 'missing_mission_code' });
    }

    const nowIso = new Date().toISOString();

    // 1. Luăm misiunea după code (și eventual active)
    const { data: mission, error: mErr } = await supa
      .from('missions')
      .select('*')
      .eq('code', mission_code)
      .eq('active', true)
      // dacă ai starts_at / ends_at în tabel, filtrezi aici:
      .lte('starts_at', nowIso)
      .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
      .maybeSingle();

    if (mErr || !mission) {
      console.warn('[missions/complete] mission_err', mErr);
      return res.status(404).json({ error: 'mission_not_found_or_inactive' });
    }

    // 2. Verificăm dacă e deja completată pentru user
    const { data: existing, error: exErr } = await supa
      .from('mission_completions')
      .select('id')
      .eq('mission_id', mission.id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (exErr) {
      console.error('[missions/complete] mission_completions check', exErr);
    }

    if (existing) {
      return res.status(400).json({ error: 'already_completed' });
    }

    // 3. Validăm progresul misiunii (logică bazată pe xp_events / chat_messages)
    const validation = await validateMissionProgress(mission, user.id);
    if (!validation.valid) {
      return res.status(400).json({
        error: validation.reason || 'Nu ai îndeplinit încă condițiile misiunii.'
      });
    }

    // 4. Marcăm misiunea ca și completată
    const { error: insErr } = await supa
      .from('mission_completions')
      .insert({
        mission_id: mission.id,
        user_id: user.id
      });

    if (insErr) {
      console.error('[missions/complete] insert', insErr);
      const msg = String(insErr.message || '').toLowerCase();
      if (msg.includes('duplicate') || msg.includes('unique')) {
        return res.status(400).json({ error: 'already_completed' });
      }
      return res.status(500).json({ error: 'mission_completion_failed' });
    }

    // 5. XP pentru misiune – dacă ai coloana xp_reward o folosim, altfel XP_BY_TYPE.mission_complete (40)
    const rewardXp = (mission.xp_reward != null ? mission.xp_reward : (XP_BY_TYPE.mission_complete || 40));
    let newTotal = null;

    try {
      newTotal = await addXp(
        user.id,
        rewardXp,
        'mission_complete',
        { mission_id: mission.id, code: mission.code }
      );
    } catch (e) {
      console.error('[missions/complete] addXp', e?.message || e);
    }

    const lvlInfo = levelFromXp(newTotal || 0);

    return res.json({
      ok: true,
      mission: {
        id: mission.id,
        code: mission.code,
        xp_reward: rewardXp,
      },
      level: lvlInfo
    });
  } catch (e) {
    console.error('[missions/complete]', e?.message || e);
    res.status(500).json({ error: 'missions-complete-failed' });
  }
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
/* ========= GLOBAL NOTIFICATIONS ========= */
app.post('/api/notifications/send-global', async (req, res) => {
  try {
    const { title, message, type } = req.body;
    const authToken = req.headers.authorization?.replace('Bearer ', '');

    const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'smartcreator_admin_2025';
    if (authToken !== ADMIN_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message required' });
    }

    const notification = {
      id: Date.now(),
      title,
      message,
      type: type || 'info',
      timestamp: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 de ore
    };

    console.log(`📢 Notificare globală: "${title}"`);

    // Broadcast la toți clienții WebSocket conectați
    broadcast({
      type: 'global-notification',
      data: notification
    });

    // Salvează în baza de date pentru utilizatorii care se conectează mai târziu
    try {
      await supa
        .from('global_notifications')
        .insert({
          title,
          message,
          type: type || 'info',
          expires_at: new Date(notification.expiresAt).toISOString()
        });
    } catch (dbError) {
      console.error('Eroare salvare notificare:', dbError);
    }

    res.json({
      success: true,
      message: `Notificare trimisă la ${wss.clients.size} utilizatori conectați`,
      notification
    });

  } catch (error) {
    console.error('❌ Eroare send-global:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint pentru a obține notificările recente
app.get('/api/notifications/recent', async (req, res) => {
  try {
    const { data, error } = await supa
      .from('global_notifications')
      .select('*')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    console.error('Eroare get notifications:', error);
    res.status(500).json({ error: error.message });
  }
});


// Endpoint pentru listarea subscription-urilor (doar admin)
app.get('/api/push/subscriptions', corsDynamic, async (req, res) => {
  const authToken = req.headers.authorization?.replace('Bearer ', '');
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'smartcreator_admin_2025';
  
  if (authToken !== ADMIN_TOKEN) {
     return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({
    total: pushSubscriptions.length,
    subscriptions: pushSubscriptions.map(sub => ({
      user: sub.user,
      endpoint: sub.subscription.endpoint?.slice(0, 50) + '...',
      timestamp: sub.timestamp
    }))
  });
});
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

// Încarcă subscription-urile la pornire
loadPushSubscriptions().then(() => {
  console.log(`[PUSH] Subscription-uri încărcate: ${pushSubscriptions.length}`);
});

/* ========= WS ========= */
const server = app.listen(PORT, ()=>{
  console.log(`[BOOT] Port=${PORT} Room=${CHAT_ROOM}`);
  console.log(`[BOOT] CORS:`, RAW_ALLOW.length ? RAW_ALLOW : '(all)');
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

if (msg?.type === 'global-notification') {
  // Afișează notificarea pentru toți clienții
  broadcast({ type: 'global-notification', data: msg.data });
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

/* =========================================
   SMART DOWNLOADER (RapidAPI: Video + Subs)
   ========================================= */
const axios = require('axios'); // Asigură-te că ai axios importat sus

// Helper pentru ID
function extractVideoId(url) {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
    return match ? match[1] : null;
}

// Helper simplu pentru a curăța textul din XML (subtitrările vin des ca XML)
function cleanTranscriptXML(xmlData) {
    if (!xmlData) return '';
    // Dacă e deja text simplu (nu are tag-uri <text>), returnăm direct
    if (!xmlData.includes('<text')) return xmlData;
    
    // Eliminăm tag-urile XML și păstrăm doar conținutul
    // Regex: Găsește tot ce e între > și <
    return xmlData
        .replace(/<[^>]*>/g, ' ')       // Șterge tag-urile
        .replace(/\s+/g, ' ')           // Elimină spațiile multiple
        .replace(/&amp;/g, '&')         // Fix caractere speciale
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .trim();
}

app.post('/api/yt-download', async (req, res) => {
  const { url } = req.body;
  console.log('[SmartDownloader] URL:', url);

  if (!url) return res.status(400).json({ success: false, error: 'URL lipsă' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ success: false, error: 'Link invalid' });

  // 🔑 CHEIA TA RAPIDAPI (Aceeași de dinainte)
  const RAPID_API_KEY = '7efb2ec2c9msh9064cf9c42d6232p172418jsn9da8ae5664d3'; 

  try {
      console.log(`[RapidAPI] Fetching details for ${videoId}...`);

      // 1. Cerem detaliile video-ului + subtitrările
      const response = await axios.get('https://youtube-media-downloader.p.rapidapi.com/v2/video/details', {
        params: { videoId: videoId },
        headers: {
          'x-rapidapi-key': RAPID_API_KEY,
          'x-rapidapi-host': 'youtube-media-downloader.p.rapidapi.com'
        }
      });

      const data = response.data;
      if (!data || !data.videos) throw new Error('API-ul nu a returnat date.');

      // --- LOGICĂ VIDEO (Prioritate 1080p cu audio) ---
      const videos = data.videos.items;
      
      // Căutăm în ordine:
      // 1. 1080p care ARE audio (uneori API-ul le marchează 'hasAudio': true sau nu specifică)
      // 2. 720p care ARE audio
      // 3. Orice mp4
      let selectedVideo = 
          videos.find(v => v.quality === '1080p' && v.extension === 'mp4' && v.hasAudio !== false) ||
          videos.find(v => v.quality === '720p' && v.extension === 'mp4') ||
          videos.find(v => v.quality === '480p' && v.extension === 'mp4') ||
          videos[0];

      if (!selectedVideo) throw new Error('Nu am găsit link video.');

      // --- LOGICĂ TRANSCRIPT (Din același răspuns) ---
      let transcriptText = null;

      // Verificăm dacă API-ul ne-a dat lista de subtitrări
      if (data.subtitles && data.subtitles.items && data.subtitles.items.length > 0) {
          const subs = data.subtitles.items;
          console.log(`[RapidAPI] Găsit ${subs.length} subtitrări.`);

          // Căutăm Română (ro) sau Engleză (en)
          // Verificăm proprietățile 'code' sau 'languageCode'
          const targetSub = subs.find(s => s.code === 'ro' || s.name?.toLowerCase().includes('romanian')) || 
                            subs.find(s => s.code === 'en' || s.name?.toLowerCase().includes('english')) || 
                            subs[0];

          if (targetSub && targetSub.url) {
              try {
                  console.log(`[Transcript] Descarc text de la: ${targetSub.url}`);
                  // Facem request direct la URL-ul subtitrării (e link public, nu costă credits)
                  const subRes = await axios.get(targetSub.url);
                  transcriptText = cleanTranscriptXML(subRes.data);
              } catch (err) {
                  console.warn('[Transcript] Eroare download text:', err.message);
              }
          }
      } else {
          console.log('[Transcript] Video-ul nu are subtitrări disponibile în API.');
      }

      console.log(`[Success] Video: ${selectedVideo.quality} | Transcript: ${transcriptText ? 'DA' : 'NU'}`);

      // Trimitem totul la frontend
      res.json({
          success: true,
          downloadUrl: selectedVideo.url,
          title: data.title || 'YouTube Video',
          thumbnail: data.thumbnails ? data.thumbnails[data.thumbnails.length - 1].url : '',
          quality: selectedVideo.quality,
          transcript: transcriptText
      });

  } catch (error) {
      console.error('[Eroare Server]:', error.response ? error.response.data : error.message);
      
      if (error.response && error.response.status === 429) {
          return res.status(429).json({ success: false, error: 'Limita zilnică RapidAPI atinsă.' });
      }

      res.status(500).json({ success: false, error: 'Eroare procesare video.' });
  }
});