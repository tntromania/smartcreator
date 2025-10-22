// --- CORS (permitem și "null" la nevoie) ---
const allowNull = process.env.ALLOW_NULL_ORIGIN === '1';

const corsOptions = {
  origin(origin, cb) {
    // 1) fără Origin (curl, server-to-server, unele preflight-uri)
    if (!origin) return cb(null, true);

    // 2) wildcard prin env
    if (CORS_ORIGIN.includes('*')) return cb(null, true);

    // 3) file:// sau iframe sandbox -> "null" (string literal)
    if (origin === 'null') {
      return allowNull ? cb(null, true) : cb(new Error('CORS blocked: null'));
    }

    // 4) match pe host (indiferent de http/https) sau string exact
    try {
      const o = new URL(origin);
      const ok = CORS_ORIGIN.some(a => {
        try {
          const u = new URL(a);
          return u.host === o.host;      // acceptă aceeași gazdă (scheme diferite OK)
        } catch {
          return a === origin;           // fallback: compară string-ul întreg
        }
      });
      return ok ? cb(null, true) : cb(new Error('CORS blocked: ' + origin));
    } catch {
      return cb(new Error('CORS blocked: ' + origin));
    }
  },
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
};

app.use(cors(corsOptions));
// preflight să folosească ACEEAȘI opțiuni
app.options('*', cors(corsOptions));
