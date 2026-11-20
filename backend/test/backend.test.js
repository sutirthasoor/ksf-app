'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createCashfree, sanitizePhone, sanitizeEmail, sanitizeId } = require('../src/cashfree');
const P = require('../src/payouts');

const cfg = { env: 'sandbox', pgAppId: 'APP', pgSecret: 'pgsecret', payoutClientId: 'CID', payoutClientSecret: 'psecret' };
const jsonRes = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });

// ---------------- cashfree client ----------------
test('sanitizers', () => {
  assert.equal(sanitizePhone('+91 98765-43210'), '9876543210');
  assert.equal(sanitizePhone('0000000000'), '9999999999');
  assert.equal(sanitizeEmail('bad'), 'noreply@example.com');
  assert.equal(sanitizeId('a b!c@d'), 'abcd');
});

test('createOrder sends PG headers/body to the sandbox host', async () => {
  let seen;
  const cf = createCashfree(cfg, async (url, init) => { seen = { url, init }; return jsonRes(200, { payment_session_id: 's1' }); });
  await cf.createOrder({ orderId: 'O1', amount: 100.456, customer: { id: 'u1', name: 'A', email: 'a@b.co', phone: '9876543210' }, returnUrl: 'r', notifyUrl: 'n' });
  assert.equal(seen.url, 'https://sandbox.cashfree.com/pg/orders');
  assert.equal(seen.init.headers['x-client-id'], 'APP');
  assert.equal(seen.init.headers['x-api-version'], '2023-08-01');
  const b = JSON.parse(seen.init.body);
  assert.equal(b.order_amount, 100.46);
  assert.equal(b.customer_details.customer_phone, '9876543210');
});

test('production host switch', async () => {
  let url;
  const cf = createCashfree({ ...cfg, env: 'production' }, async (u) => { url = u; return jsonRes(200, {}); });
  await cf.getTransfer('T1');
  assert.equal(url, 'https://api.cashfree.com/payout/transfers?transfer_id=T1');
});

test('webhook signature', () => {
  const cf = createCashfree(cfg, null);
  const body = '{"a":1}', ts = '1700000000000';
  const sig = crypto.createHmac('sha256', 'pgsecret').update(ts + body).digest('base64');
  assert.equal(cf.verifyWebhookSignature('pgsecret', Buffer.from(body), sig, ts), true);
  assert.equal(cf.verifyWebhookSignature('pgsecret', Buffer.from(body + ' '), sig, ts), false);
  assert.equal(cf.verifyWebhookSignature('wrong', Buffer.from(body), sig, ts), false);
  assert.equal(cf.verifyWebhookSignature('pgsecret', Buffer.from(body), '', ts), false);
});

test('receipt sign/verify binds order, payment and amount', () => {
  const cf = createCashfree(cfg, null);
  const sig = cf.signReceipt('O1', '77', 500);
  assert.equal(cf.verifyReceipt('O1', '77', 500, sig), true);
  assert.equal(cf.verifyReceipt('O1', '77', 501, sig), false);
  assert.equal(cf.verifyReceipt('O2', '77', 500, sig), false);
  assert.equal(cf.verifyReceipt('O1', '78', 500, sig), false);
});

test('getOrderOutcome only trusts PAID + a SUCCESS payment', async () => {
  const cf = createCashfree(cfg, async (url) =>
    url.endsWith('/payments')
      ? jsonRes(200, [{ cf_payment_id: 5, payment_status: 'FAILED' }, { cf_payment_id: 6, payment_status: 'SUCCESS' }])
      : jsonRes(200, { order_status: 'PAID', order_amount: 10 }));
  const o = await cf.getOrderOutcome('O1');
  assert.deepEqual([o.paid, o.paymentId, o.amount], [true, '6', 10]);
  const cf2 = createCashfree(cfg, async () => jsonRes(200, { order_status: 'ACTIVE', order_amount: 10 }));
  assert.equal((await cf2.getOrderOutcome('O1')).paid, false);
});

// ---------------- payout state machine (in-memory store with same semantics) ----------------
function memStore(w, wallet = { balance: 0, totalWithdrawn: w.amount }) {
  const s = {
    w: { status: 'pending', ...w }, wallet, calls: [],
    getWithdrawal: async () => ({ id: 'W1', ...s.w }),
    getUser: async () => ({ fullName: 'Asha', email: 'a@b.co', phone: '9876543210' }),
    claimForProcessing: async () => {
      if (s.w.status !== 'pending') throw Object.assign(new Error(`Withdrawal is already ${s.w.status}`), { status: 409, userFacing: true });
      s.w.status = 'processing'; return { id: 'W1', ...s.w };
    },
    revertToPending: async (_i, e) => { s.w.status = 'pending'; s.w.lastError = e; },
    noteError: async (_i, e) => { s.w.lastError = e; },
    rejectPending: async () => {
      if (s.w.status !== 'pending') throw Object.assign(new Error('not pending'), { status: 409, userFacing: true });
      s.wallet.balance += s.w.amount; s.wallet.totalWithdrawn -= s.w.amount; s.w.status = 'rejected'; s.w.refunded = true; return { status: 'rejected' };
    },
    applyOutcome: async (_i, o) => {
      if (o.outcome === 'paid') { s.w.status = 'paid'; return { status: 'paid' }; }
      if (o.outcome === 'failed') {
        if (!s.w.refunded) { s.wallet.balance += s.w.amount; s.wallet.totalWithdrawn -= s.w.amount; s.w.refunded = true; }
        s.w.status = 'failed'; return { status: 'failed' };
      }
      s.w.cfTransferId = o.cfTransferId; return { status: s.w.status };
    },
  };
  return s;
}
const bank = { accountNumber: '1234567890', ifscCode: 'hdfc0001234', accountHolderName: 'Asha' };
const fakeCf = (over = {}) => ({
  calls: [],
  createBeneficiary: async function (a) { this.calls.push(['ben', a]); },
  createTransfer: async function (a) { this.calls.push(['xfer', a]); return { status: 'RECEIVED', cf_transfer_id: 9 }; },
  getTransfer: async () => ({ status: 'SUCCESS', cf_transfer_id: 9 }),
  ...over,
});

test('approve -> bank transfer payload, stays processing until webhook/sync', async () => {
  const store = memStore({ userId: 'u1', amount: 250, bankDetails: bank });
  const cf = fakeCf();
  const r = await P.approveAndPay({ store, cf, withdrawalId: 'W1', adminUid: 'adm' });
  assert.equal(r.status, 'processing');
  const [, x] = cf.calls.find((c) => c[0] === 'xfer');
  assert.equal(x.transferId, 'WD_W1'); assert.equal(x.amount, 250); assert.equal(x.mode, 'banktransfer');
  assert.equal(cf.calls.find((c) => c[0] === 'ben')[1].ifsc, 'HDFC0001234');
});

test('double approve cannot pay twice', async () => {
  const store = memStore({ userId: 'u1', amount: 250, bankDetails: bank });
  const cf = fakeCf();
  await P.approveAndPay({ store, cf, withdrawalId: 'W1', adminUid: 'a' });
  await assert.rejects(P.approveAndPay({ store, cf, withdrawalId: 'W1', adminUid: 'a' }), /already processing/);
  assert.equal(cf.calls.filter((c) => c[0] === 'xfer').length, 1);
});

test('UPI-only withdrawal uses upi mode; junk details are refused before calling Cashfree', async () => {
  const s1 = memStore({ userId: 'u1', amount: 100, bankDetails: { upiId: 'asha@okhdfc' } });
  const cf = fakeCf();
  await P.approveAndPay({ store: s1, cf, withdrawalId: 'W1', adminUid: 'a' });
  assert.equal(cf.calls.find((c) => c[0] === 'xfer')[1].mode, 'upi');

  const s2 = memStore({ userId: 'u1', amount: 100, bankDetails: { accountNumber: '12', ifscCode: 'BAD' } });
  const cf2 = fakeCf();
  await assert.rejects(P.approveAndPay({ store: s2, cf: cf2, withdrawalId: 'W1', adminUid: 'a' }), /Invalid bank account/);
  assert.equal(s2.w.status, 'pending'); assert.equal(cf2.calls.length, 0);
});

test('Cashfree 4xx reverts to pending; network error keeps processing (unknown outcome)', async () => {
  const s1 = memStore({ userId: 'u1', amount: 100, bankDetails: bank });
  await assert.rejects(P.approveAndPay({ store: s1, adminUid: 'a', withdrawalId: 'W1',
    cf: fakeCf({ createTransfer: async () => { throw Object.assign(new Error('insufficient balance'), { status: 400 }); } }) }));
  assert.equal(s1.w.status, 'pending');

  const s2 = memStore({ userId: 'u1', amount: 100, bankDetails: bank });
  await assert.rejects(P.approveAndPay({ store: s2, adminUid: 'a', withdrawalId: 'W1',
    cf: fakeCf({ createTransfer: async () => { throw Object.assign(new Error('net'), { network: true }); } }) }));
  assert.equal(s2.w.status, 'processing');
});

test('beneficiary already exists (409) is tolerated; duplicate transfer 409 falls back to status', async () => {
  const store = memStore({ userId: 'u1', amount: 100, bankDetails: bank });
  const cf = fakeCf({
    createBeneficiary: async () => { throw Object.assign(new Error('Beneficiary already exists'), { status: 409 }); },
    createTransfer: async () => { throw Object.assign(new Error('dup'), { status: 409 }); },
    getTransfer: async () => ({ status: 'SUCCESS' }),
  });
  assert.equal((await P.approveAndPay({ store, cf, withdrawalId: 'W1', adminUid: 'a' })).status, 'paid');
});

test('FAILED / REVERSED refund the wallet exactly once, even if reported repeatedly', async () => {
  const store = memStore({ userId: 'u1', amount: 300, bankDetails: bank });
  await P.approveAndPay({ store, cf: fakeCf(), withdrawalId: 'W1', adminUid: 'a' });
  const failing = fakeCf({ getTransfer: async () => ({ status: 'FAILED' }) });
  await P.syncWithdrawal({ store, cf: failing, withdrawalId: 'W1' });
  await P.syncWithdrawal({ store, cf: failing, withdrawalId: 'W1' }); // second webhook delivery
  assert.deepEqual([store.w.status, store.wallet.balance, store.wallet.totalWithdrawn], ['failed', 300, 0]);
});

test('sync of a transfer Cashfree never received reverts to pending', async () => {
  const store = memStore({ userId: 'u1', amount: 100, bankDetails: bank });
  await assert.rejects(P.approveAndPay({ store, adminUid: 'a', withdrawalId: 'W1',
    cf: fakeCf({ createTransfer: async () => { throw Object.assign(new Error('net'), { network: true }); } }) }));
  await P.syncWithdrawal({ store, withdrawalId: 'W1', cf: fakeCf({ getTransfer: async () => { throw Object.assign(new Error('nf'), { status: 404 }); } }) });
  assert.equal(store.w.status, 'pending');
});

test('reject refunds once and only while pending', async () => {
  const store = memStore({ userId: 'u1', amount: 120, bankDetails: bank });
  await P.rejectWithdrawal({ store, withdrawalId: 'W1', reason: 'x', adminUid: 'a' });
  assert.deepEqual([store.wallet.balance, store.wallet.totalWithdrawn], [120, 0]);
  await assert.rejects(P.rejectWithdrawal({ store, withdrawalId: 'W1', adminUid: 'a' }));
  assert.equal(store.wallet.balance, 120);
});

test('webhook payload parsing', () => {
  assert.equal(P.withdrawalIdFromTransferId(P.transferIdFromWebhook({ data: { transfer_id: 'WD_abc123' } })), 'abc123');
  assert.equal(P.withdrawalIdFromTransferId('OTHER_1'), null);
  assert.equal(P.classify('SUCCESS'), 'paid');
  assert.equal(P.classify('reversed'), 'failed');
  assert.equal(P.classify('PENDING'), 'processing');
});
