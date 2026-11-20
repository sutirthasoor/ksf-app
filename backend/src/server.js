'use strict';
// Minimal .env loader (no dependency). Real environment variables (e.g. Railway) always win.
try {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if (v.length > 1 && ((v[0] === "'" && v.endsWith("'")) || (v[0] === '"' && v.endsWith('"')))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
} catch (e) { console.warn('Could not read .env:', e.message); }
const admin = require('firebase-admin');
const { createCashfree } = require('./cashfree');
const { createFirestoreStore } = require('./firestoreStore');
const { createApp } = require('./app');

const env = process.env;
const cfg = {
  env: env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
  pgAppId: env.CASHFREE_PG_APP_ID,
  pgSecret: env.CASHFREE_PG_SECRET,
  payoutClientId: env.CASHFREE_PAYOUT_CLIENT_ID,
  payoutClientSecret: env.CASHFREE_PAYOUT_CLIENT_SECRET,
  payoutWebhookSecret: env.CASHFREE_PAYOUT_WEBHOOK_SECRET,
  publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  corsOrigins: env.CORS_ORIGINS,
  maxOrderAmount: Number(env.MAX_ORDER_AMOUNT) || 500000,
};

for (const [k, v] of Object.entries({
  CASHFREE_PG_APP_ID: cfg.pgAppId, CASHFREE_PG_SECRET: cfg.pgSecret,
  CASHFREE_PAYOUT_CLIENT_ID: cfg.payoutClientId, CASHFREE_PAYOUT_CLIENT_SECRET: cfg.payoutClientSecret,
  PUBLIC_BASE_URL: cfg.publicBaseUrl, FIREBASE_SERVICE_ACCOUNT: env.FIREBASE_SERVICE_ACCOUNT,
})) {
  if (!v) { console.error(`Missing required env var ${k} (see .env.example)`); process.exit(1); }
}

const raw = env.FIREBASE_SERVICE_ACCOUNT.trim();
const serviceAccount = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const app = createApp({
  cfg,
  cf: createCashfree(cfg),
  store: createFirestoreStore(admin.firestore()),
  verifyIdToken: (t) => admin.auth().verifyIdToken(t),
});

const port = Number(env.PORT) || 3000;
app.listen(port, () => console.log(`NGO backend (${cfg.env}) listening on :${port}`));
