'use strict';
/** Firestore persistence for withdrawals + payment orders (firebase-admin). All transitions are atomic. */
const admin = require('firebase-admin');

const conflict = (msg) => Object.assign(new Error(msg), { status: 409, userFacing: true });
const notFound = (msg) => Object.assign(new Error(msg), { status: 404, userFacing: true });

function createFirestoreStore(db) {
  const now = () => admin.firestore.Timestamp.now();
  const inc = (n) => admin.firestore.FieldValue.increment(n);
  const wRef = (id) => db.collection('withdrawals').doc(id);

  // wallet transaction rows created by WalletService.processWithdrawal (referenceId = withdrawal id)
  const txQuery = (id) =>
    db.collection('walletTransactions').where('referenceId', '==', id).where('type', '==', 'withdrawal');

  return {
    async getWithdrawal(id) {
      const s = await wRef(id).get();
      return s.exists ? { id: s.id, ...s.data() } : null;
    },
    async getUser(uid) {
      const s = await db.collection('users').doc(uid).get();
      return s.exists ? s.data() : null;
    },

    claimForProcessing: (id, adminUid) =>
      db.runTransaction(async (t) => {
        const s = await t.get(wRef(id));
        if (!s.exists) throw notFound('Withdrawal not found');
        const w = s.data();
        if (w.status !== 'pending') throw conflict(`Withdrawal is already ${w.status}`);
        t.update(wRef(id), {
          status: 'processing', approvedBy: adminUid, approvedAt: now(), updatedAt: now(),
          lastError: admin.firestore.FieldValue.delete(),
        });
        return { id, ...w };
      }),

    revertToPending: (id, error) =>
      wRef(id).update({ status: 'pending', lastError: String(error).slice(0, 300), updatedAt: now() }),

    noteError: (id, error) =>
      wRef(id).update({ lastError: String(error).slice(0, 300), updatedAt: now() }),

    rejectPending: (id, reason, adminUid) =>
      db.runTransaction(async (t) => {
        const s = await t.get(wRef(id));
        if (!s.exists) throw notFound('Withdrawal not found');
        const w = s.data();
        if (w.status !== 'pending') throw conflict(`Only pending withdrawals can be rejected (is ${w.status})`);
        const txs = await t.get(txQuery(id));
        const walletRef = db.collection('wallets').doc(w.userId);
        t.set(walletRef, { balance: inc(w.amount), totalWithdrawn: inc(-w.amount), updatedAt: now() }, { merge: true });
        t.update(wRef(id), {
          status: 'rejected', reason, rejectedBy: adminUid, rejectedAt: now(), refunded: true, updatedAt: now(),
        });
        txs.forEach((d) => t.update(d.ref, { status: 'rejected', updatedAt: now() }));
        return { status: 'rejected' };
      }),

    /** Idempotent: safe to call repeatedly from sync + webhook. */
    applyOutcome: (id, o) =>
      db.runTransaction(async (t) => {
        const s = await t.get(wRef(id));
        if (!s.exists) throw notFound('Withdrawal not found');
        const w = s.data();
        const txs = await t.get(txQuery(id));
        const base = {
          transferStatus: o.cfStatus || null,
          ...(o.cfTransferId ? { cfTransferId: o.cfTransferId } : {}),
          updatedAt: now(),
        };

        if (o.outcome === 'paid') {
          if (w.status === 'paid') return { status: 'paid', unchanged: true };
          t.update(wRef(id), {
            ...base, status: 'paid', utr: o.utr || null, paidAt: now(),
            ...(w.refunded ? { needsReview: true } : {}), // paid after we already refunded: flag for humans
          });
          txs.forEach((d) => t.update(d.ref, { status: 'completed', updatedAt: now() }));
          return { status: 'paid' };
        }

        if (o.outcome === 'failed') {
          if (w.refunded) { t.update(wRef(id), base); return { status: w.status, unchanged: true }; }
          const walletRef = db.collection('wallets').doc(w.userId);
          t.set(walletRef, { balance: inc(w.amount), totalWithdrawn: inc(-w.amount), updatedAt: now() }, { merge: true });
          t.update(wRef(id), {
            ...base, status: 'failed', refunded: true, failureReason: o.reason || o.cfStatus || 'Transfer failed',
            failedAt: now(),
          });
          txs.forEach((d) => t.update(d.ref, { status: 'failed', updatedAt: now() }));
          return { status: 'failed', refunded: true };
        }

        // still in flight
        if (w.status === 'processing') t.update(wRef(id), base);
        return { status: w.status, transferStatus: o.cfStatus };
      }),

    // ---------- PG payment orders ----------
    async saveOrder(orderId, data) {
      await db.collection('paymentOrders').doc(orderId).set({ ...data, createdAt: now(), updatedAt: now() });
    },
    async getOrder(orderId) {
      const s = await db.collection('paymentOrders').doc(orderId).get();
      return s.exists ? s.data() : null;
    },
    async updateOrder(orderId, patch) {
      await db.collection('paymentOrders').doc(orderId).set({ ...patch, updatedAt: now() }, { merge: true });
    },
  };
}

module.exports = { createFirestoreStore };
