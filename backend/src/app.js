'use strict';
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const P = require('./payouts');

const PURPOSES = new Set(['donation', 'ecommerce', 'registration', 'class', 'competition', 'other']);
const esc = (s) => JSON.stringify(String(s)).replace(/</g, '\\u003c');

function createApp({ cfg, cf, store, verifyIdToken }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const origins = (cfg.corsOrigins || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors(origins.length ? { origin: origins } : {}));

  // ---------- tiny in-memory rate limiter ----------
  const hits = new Map();
  const limit = (max, windowMs) => (req, res, next) => {
    const k = `${req.ip}:${req.path}`;
    const t = Date.now();
    const arr = (hits.get(k) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) return res.status(429).json({ success: false, message: 'Too many requests' });
    arr.push(t); hits.set(k, arr); next();
  };
  setInterval(() => hits.clear(), 15 * 60 * 1000).unref();

  const fail = (res, e) => {
    const status = e.status && e.status < 600 ? (e.userFacing ? e.status : e.status >= 500 ? 502 : 400) : 500;
    if (!e.userFacing) console.error('[error]', e.message, e.body ? JSON.stringify(e.body) : '');
    res.status(status).json({ success: false, message: e.userFacing ? e.message : (e.body && e.body.message) || e.message });
  };
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => fail(res, e));

  // ---------- auth ----------
  const bearer = (req) => (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
  const optionalUid = async (req) => {
    const tok = bearer(req);
    if (!tok) return null;
    try { return (await verifyIdToken(tok)).uid; } catch { return null; }
  };
  const requireAdmin = async (req, res, next) => {
    try {
      const tok = bearer(req);
      if (!tok) return res.status(401).json({ success: false, message: 'Sign-in required' });
      const { uid } = await verifyIdToken(tok);
      const u = await store.getUser(uid);
      if (!u || !['admin', 'super_admin'].includes(u.role)) {
        return res.status(403).json({ success: false, message: 'Admin only' });
      }
      req.uid = uid;
      next();
    } catch (e) { res.status(401).json({ success: false, message: 'Invalid or expired session' }); }
  };

  // =====================================================================
  // WEBHOOKS (raw body needed for signature) - registered BEFORE express.json
  // =====================================================================
  app.post('/api/cashfree/webhook', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
    const ok = cf.verifyWebhookSignature(cfg.pgSecret, req.body, req.headers['x-webhook-signature'], req.headers['x-webhook-timestamp']);
    if (!ok) return res.status(401).send('bad signature');
    let body; try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('bad json'); }
    const orderId = body && body.data && body.data.order && body.data.order.order_id;
    if (orderId && (await store.getOrder(orderId))) {
      // never trust the payload; ask Cashfree for the truth
      const out = await cf.getOrderOutcome(orderId);
      await store.updateOrder(orderId, { status: out.status, paid: out.paid, paymentId: out.paymentId, webhookAt: new Date().toISOString() });
    }
    res.status(200).send('ok');
  }));

  // Payout webhook: ALWAYS acknowledge with 200 (Cashfree's "Test & Add" ping and retries need it).
  // Nothing in the payload is trusted: we only extract the transfer id and re-read the real status
  // from Cashfree, which is idempotent, so an unsigned/forged call can at worst trigger a harmless re-check.
  app.post('/api/cashfree/payout-webhook', limit(120, 60 * 1000), express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    try {
      const secret = cfg.payoutWebhookSecret || cfg.payoutClientSecret;
      const signed = cf.verifyWebhookSignature(secret, req.body, req.headers['x-webhook-signature'], req.headers['x-webhook-timestamp']);
      if (!signed) console.warn('[payout-webhook] signature not verified (processing via re-fetch only)');
      let body = {};
      try { body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}'); } catch { /* ping / non-JSON */ }
      const wid = P.withdrawalIdFromTransferId(P.transferIdFromWebhook(body));
      if (wid && (await store.getWithdrawal(wid))) {
        await P.syncWithdrawal({ store, cf, withdrawalId: wid });
      }
    } catch (e) {
      console.error('[payout-webhook]', e.message);
    }
    res.status(200).send('ok');
  });

  app.use(express.json({ limit: '100kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, env: cfg.env }));

  // =====================================================================
  // PAYMENT GATEWAY: donations, e-commerce, registrations
  // =====================================================================
  app.post('/api/cashfree/orders', limit(30, 10 * 60 * 1000), wrap(async (req, res) => {
    const { amount, purpose = 'donation', description, customer = {} } = req.body || {};
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(amt) || amt < 1) return res.status(400).json({ success: false, message: 'Minimum amount is ₹1' });
    if (amt > cfg.maxOrderAmount) return res.status(400).json({ success: false, message: `Maximum amount is ₹${cfg.maxOrderAmount}` });
    if (!PURPOSES.has(purpose)) return res.status(400).json({ success: false, message: 'Invalid purpose' });

    const uid = await optionalUid(req);
    const orderId = `ORD_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
    const https = /^https:\/\//.test(cfg.publicBaseUrl || '');
    const order = await cf.createOrder({
      orderId,
      amount: amt,
      customer: { id: uid || `guest_${crypto.randomBytes(4).toString('hex')}`, name: customer.name, email: customer.email, phone: customer.phone },
      returnUrl: `${cfg.publicBaseUrl}/pay-return?order_id={order_id}`,
      notifyUrl: https ? `${cfg.publicBaseUrl}/api/cashfree/webhook` : undefined,
      note: description,
      tags: { purpose },
    });
    await store.saveOrder(orderId, {
      orderId, cfOrderId: order.cf_order_id || null, amount: amt, purpose, uid: uid || null,
      description: description || '', sessionId: order.payment_session_id, status: order.order_status || 'ACTIVE', paid: false,
    });
    res.json({ success: true, orderId, paymentSessionId: order.payment_session_id, amount: amt, currency: 'INR', env: cfg.env });
  }));

  const orderStatus = async (orderId) => {
    const rec = await store.getOrder(orderId);
    if (!rec) throw Object.assign(new Error('Order not found'), { status: 404, userFacing: true });
    const out = await cf.getOrderOutcome(orderId);
    const amountOk = Math.abs(out.amount - rec.amount) < 0.005;
    const paid = out.paid && amountOk && !!out.paymentId;
    await store.updateOrder(orderId, { status: out.status, paid, paymentId: out.paymentId || null });
    return {
      orderId, status: amountOk ? out.status : 'AMOUNT_MISMATCH', paid, amount: rec.amount,
      paymentId: paid ? out.paymentId : null,
      signature: paid ? cf.signReceipt(orderId, out.paymentId, rec.amount) : null,
    };
  };

  app.get('/api/cashfree/orders/:orderId', limit(120, 10 * 60 * 1000), wrap(async (req, res) => {
    res.json({ success: true, ...(await orderStatus(req.params.orderId)) });
  }));

  app.post('/api/cashfree/verify', limit(60, 10 * 60 * 1000), wrap(async (req, res) => {
    const { orderId, paymentId, signature } = req.body || {};
    if (!orderId || !paymentId || !signature) return res.status(400).json({ success: false, message: 'orderId, paymentId and signature are required' });
    const s = await orderStatus(orderId);
    const ok = s.paid && s.paymentId === String(paymentId) && cf.verifyReceipt(orderId, paymentId, s.amount, signature);
    res.status(ok ? 200 : 400).json({ success: ok, message: ok ? 'Payment verified' : 'Payment could not be verified' });
  }));

  // Hosted checkout page used by the native app (opened in the system browser)
  app.get('/pay/:orderId', wrap(async (req, res) => {
    const rec = await store.getOrder(req.params.orderId);
    if (!rec || !req.query.s || req.query.s !== rec.sessionId) return res.status(404).send('Invalid payment link');
    res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure payment</title>
<style>body{font-family:system-ui,sans-serif;text-align:center;padding:48px 16px;color:#334155}</style></head>
<body><p>Opening secure payment…</p>
<script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
<script>
  var cashfree = Cashfree({ mode: ${esc(cfg.env === 'production' ? 'production' : 'sandbox')} });
  cashfree.checkout({ paymentSessionId: ${esc(rec.sessionId)}, redirectTarget: '_self' });
</script></body></html>`);
  }));

  app.get('/pay-return', (req, res) => {
    const id = String(req.query.order_id || '').replace(/[^A-Za-z0-9_-]/g, '');
    res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment</title>
<style>body{font-family:system-ui,sans-serif;text-align:center;padding:48px 16px;color:#334155}</style></head>
<body><h2>Thank you</h2><p>We are confirming your payment. You can close this page and return to the app.</p>
<script>setTimeout(function(){ location.href = 'ksdf://payment-return?order_id=${id}'; }, 400);</script></body></html>`);
  });

  // =====================================================================
  // PAYOUTS: working-member wallet withdrawals (admin only)
  // =====================================================================
  app.post('/api/payouts/withdrawals/:id/approve', requireAdmin, wrap(async (req, res) => {
    const r = await P.approveAndPay({ store, cf, withdrawalId: req.params.id, adminUid: req.uid });
    res.json({ success: true, ...r });
  }));
  app.post('/api/payouts/withdrawals/:id/sync', requireAdmin, wrap(async (req, res) => {
    res.json({ success: true, ...(await P.syncWithdrawal({ store, cf, withdrawalId: req.params.id })) });
  }));
  app.post('/api/payouts/withdrawals/:id/reject', requireAdmin, wrap(async (req, res) => {
    const r = await P.rejectWithdrawal({ store, withdrawalId: req.params.id, reason: (req.body || {}).reason, adminUid: req.uid });
    res.json({ success: true, ...r });
  }));

  return app;
}

module.exports = { createApp };
