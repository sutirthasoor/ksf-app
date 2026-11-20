'use strict';
/**
 * Thin Cashfree client for Payment Gateway (PG, api 2023-08-01) and
 * Payouts v2 (api 2024-01-01). No dependencies; `fetch` is injectable for tests.
 */
const crypto = require('crypto');

const PG_VERSION = '2023-08-01';
const PAYOUT_VERSION = '2024-01-01';

// ---------- sanitizers (Cashfree is strict about these) ----------
const sanitizeId = (s, max = 45) =>
  String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, max);

const sanitizePhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  const last10 = d.slice(-10);
  return /^[6-9]\d{9}$/.test(last10) ? last10 : '9999999999';
};

const sanitizeEmail = (e) => {
  const v = String(e || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : 'noreply@example.com';
};

const sanitizeName = (n, fallback = 'Supporter') => {
  const v = String(n || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 100);
  return v || fallback;
};

const money = (n) => Math.round(Number(n) * 100) / 100;

function createCashfree(cfg, fetchImpl = globalThis.fetch) {
  const production = cfg.env === 'production';
  const host = production ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
  const pgBase = `${host}/pg`;
  const payoutBase = `${host}/payout`;

  const pgHeaders = () => ({
    'x-client-id': cfg.pgAppId,
    'x-client-secret': cfg.pgSecret,
    'x-api-version': PG_VERSION,
  });
  const payoutHeaders = () => ({
    'x-client-id': cfg.payoutClientId,
    'x-client-secret': cfg.payoutClientSecret,
    'x-api-version': PAYOUT_VERSION,
  });

  async function call(url, { method = 'GET', headers, body } = {}) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (netErr) {
      const e = new Error(`Network error talking to Cashfree: ${netErr.message}`);
      e.network = true; // outcome unknown
      throw e;
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const e = new Error(json.message || `Cashfree HTTP ${res.status}`);
      e.status = res.status;
      e.code = json.code || json.type;
      e.body = json;
      throw e;
    }
    return json;
  }

  // ---------------- PG ----------------
  const createOrder = ({ orderId, amount, customer, returnUrl, notifyUrl, note, tags }) =>
    call(`${pgBase}/orders`, {
      method: 'POST',
      headers: pgHeaders(),
      body: {
        order_id: orderId,
        order_amount: money(amount),
        order_currency: 'INR',
        order_note: note ? String(note).slice(0, 200) : undefined,
        order_tags: tags,
        customer_details: {
          customer_id: sanitizeId(customer.id, 50) || 'guest',
          customer_name: sanitizeName(customer.name),
          customer_email: sanitizeEmail(customer.email),
          customer_phone: sanitizePhone(customer.phone),
        },
        order_meta: { return_url: returnUrl, notify_url: notifyUrl },
      },
    });

  const getOrder = (orderId) =>
    call(`${pgBase}/orders/${encodeURIComponent(orderId)}`, { headers: pgHeaders() });

  const getOrderPayments = (orderId) =>
    call(`${pgBase}/orders/${encodeURIComponent(orderId)}/payments`, { headers: pgHeaders() });

  /** Source of truth: asks Cashfree whether the order is paid and for which payment. */
  async function getOrderOutcome(orderId) {
    const order = await getOrder(orderId);
    const out = {
      status: order.order_status, // ACTIVE | PAID | EXPIRED | TERMINATED ...
      paid: order.order_status === 'PAID',
      amount: Number(order.order_amount),
      paymentId: null,
      raw: order,
    };
    if (out.paid) {
      const payments = await getOrderPayments(orderId);
      const ok = (Array.isArray(payments) ? payments : []).find((p) => p.payment_status === 'SUCCESS');
      out.paymentId = ok ? String(ok.cf_payment_id) : null;
    }
    return out;
  }

  // ---------------- Payouts v2 ----------------
  const createBeneficiary = ({ beneficiaryId, name, bankAccount, ifsc, vpa, email, phone }) =>
    call(`${payoutBase}/beneficiary`, {
      method: 'POST',
      headers: payoutHeaders(),
      body: {
        beneficiary_id: beneficiaryId,
        beneficiary_name: sanitizeName(name, 'Member'),
        beneficiary_instrument_details: vpa
          ? { vpa }
          : { bank_account_number: bankAccount, bank_ifsc: ifsc },
        beneficiary_contact_details: {
          beneficiary_email: sanitizeEmail(email),
          beneficiary_phone: sanitizePhone(phone),
          beneficiary_country_code: '+91',
        },
      },
    });

  const createTransfer = ({ transferId, amount, beneficiaryId, mode, remarks }) =>
    call(`${payoutBase}/transfers`, {
      method: 'POST',
      headers: payoutHeaders(),
      body: {
        transfer_id: transferId,
        transfer_amount: money(amount),
        transfer_currency: 'INR',
        transfer_mode: mode,
        transfer_remarks: remarks ? String(remarks).slice(0, 70) : undefined,
        beneficiary_details: { beneficiary_id: beneficiaryId },
      },
    });

  const getTransfer = (transferId) =>
    call(`${payoutBase}/transfers?transfer_id=${encodeURIComponent(transferId)}`, {
      headers: payoutHeaders(),
    });

  // ---------------- signatures ----------------
  /** Cashfree webhook: base64(HMAC_SHA256(timestamp + rawBody, secret)) */
  function verifyWebhookSignature(secret, rawBody, signature, timestamp) {
    if (!secret || !signature || !timestamp) return false;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(String(timestamp) + (Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)))
      .digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Server-issued receipt that the app hands back to /verify (HMAC over the paid facts). */
  const signReceipt = (orderId, paymentId, amount) =>
    crypto.createHmac('sha256', cfg.pgSecret).update(`${orderId}|${paymentId}|${money(amount)}`).digest('hex');

  const verifyReceipt = (orderId, paymentId, amount, signature) => {
    const a = Buffer.from(signReceipt(orderId, paymentId, amount));
    const b = Buffer.from(String(signature || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  return {
    production,
    createOrder, getOrder, getOrderPayments, getOrderOutcome,
    createBeneficiary, createTransfer, getTransfer,
    verifyWebhookSignature, signReceipt, verifyReceipt,
  };
}

module.exports = { createCashfree, sanitizeId, sanitizePhone, sanitizeEmail, sanitizeName, money };
