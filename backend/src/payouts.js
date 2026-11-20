'use strict';
/**
 * Withdrawal payout flow (working-member wallet -> bank / UPI via Cashfree Payouts v2).
 *
 *   pending --approve--> processing --SUCCESS--> paid
 *      |                     |--FAILED/REJECTED/REVERSED--> failed (wallet refunded once)
 *      '--reject--> rejected (wallet refunded once)
 *
 * The member's wallet is debited when the withdrawal is requested (WalletService.processWithdrawal),
 * so a failed/rejected payout must credit it back exactly once. `store` hides persistence
 * (Firestore in production, an in-memory fake in tests) and implements atomic transitions.
 */
const crypto = require('crypto');
const { sanitizeId } = require('./cashfree');

const SUCCESS = new Set(['SUCCESS']);
const FAILURE = new Set(['FAILED', 'REJECTED', 'REVERSED', 'CANCELLED']);

const classify = (cfStatus) => {
  const s = String(cfStatus || '').toUpperCase();
  if (SUCCESS.has(s)) return 'paid';
  if (FAILURE.has(s)) return 'failed';
  return 'processing';
};

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const VPA_RE = /^[A-Za-z0-9.\-_]{2,256}@[A-Za-z]{2,64}$/;

/** Decide bank vs UPI and validate. Bank wins when full bank details exist. */
function resolveInstrument(bankDetails = {}) {
  const acct = String(bankDetails.accountNumber || '').replace(/\s/g, '');
  const ifsc = String(bankDetails.ifscCode || '').trim().toUpperCase();
  const vpa = String(bankDetails.upiId || '').trim();
  if (acct && ifsc) {
    if (!/^\d{5,25}$/.test(acct)) throw userError('Invalid bank account number');
    if (!IFSC_RE.test(ifsc)) throw userError('Invalid IFSC code');
    return { kind: 'bank', bankAccount: acct, ifsc, mode: 'banktransfer' };
  }
  if (vpa) {
    if (!VPA_RE.test(vpa)) throw userError('Invalid UPI ID');
    return { kind: 'upi', vpa, mode: 'upi' };
  }
  throw userError('Withdrawal has no usable bank or UPI details');
}

function userError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  e.userFacing = true;
  return e;
}

const beneficiaryIdFor = (userId, instrument) =>
  'B_' + crypto.createHash('sha1')
    .update([userId, instrument.bankAccount || '', instrument.ifsc || '', instrument.vpa || ''].join('|'))
    .digest('hex').slice(0, 30);

const transferIdFor = (withdrawalId) => `WD_${sanitizeId(withdrawalId, 40)}`;

/** Apply a Cashfree transfer status to our records (idempotent). */
async function applyTransfer({ store, withdrawalId, transfer }) {
  const cfStatus = transfer.status || transfer.transfer_status;
  const outcome = classify(cfStatus);
  return store.applyOutcome(withdrawalId, {
    outcome, // paid | failed | processing
    cfStatus,
    cfTransferId: transfer.cf_transfer_id ? String(transfer.cf_transfer_id) : null,
    utr: transfer.transfer_utr || transfer.utr || null,
    reason: transfer.status_description || transfer.reason || null,
  });
}

async function approveAndPay({ store, cf, withdrawalId, adminUid }) {
  // Atomic pending -> processing. Throws if already claimed (prevents double payout).
  const w = await store.claimForProcessing(withdrawalId, adminUid);
  const transferId = transferIdFor(withdrawalId);
  let transfer;
  try {
    const instrument = resolveInstrument(w.bankDetails);
    const user = (await store.getUser(w.userId)) || {};
    const beneficiaryId = beneficiaryIdFor(w.userId, instrument);

    try {
      await cf.createBeneficiary({
        beneficiaryId,
        name: w.bankDetails.accountHolderName || user.fullName || user.name,
        bankAccount: instrument.bankAccount,
        ifsc: instrument.ifsc,
        vpa: instrument.vpa,
        email: user.email,
        phone: user.phone || user.phoneNumber,
      });
    } catch (e) {
      // Same id => same details by construction, so "already exists" is fine.
      if (!(e.status === 409 || /already exist/i.test(e.message || ''))) throw e;
    }

    try {
      transfer = await cf.createTransfer({
        transferId,
        amount: w.amount,
        beneficiaryId,
        mode: instrument.mode,
        remarks: 'Wallet withdrawal',
      });
    } catch (e) {
      if (e.status === 409) transfer = await cf.getTransfer(transferId); // already created earlier
      else throw e;
    }
  } catch (e) {
    if (e.userFacing || (e.status && e.status < 500)) {
      // Definitive: Cashfree/us refused. Nothing was sent -> back to pending for admin to fix/reject.
      await store.revertToPending(withdrawalId, e.message);
    } else {
      // Outcome unknown (network / 5xx). Keep 'processing'; admin uses Sync to resolve.
      await store.noteError(withdrawalId, e.message);
    }
    throw e;
  }
  return applyTransfer({ store, withdrawalId, transfer });
}

async function syncWithdrawal({ store, cf, withdrawalId }) {
  const w = await store.getWithdrawal(withdrawalId);
  if (!w) throw userError('Withdrawal not found', 404);
  if (!['processing', 'paid'].includes(w.status)) return { status: w.status, unchanged: true };
  try {
    const transfer = await cf.getTransfer(transferIdFor(withdrawalId));
    return await applyTransfer({ store, withdrawalId, transfer });
  } catch (e) {
    if (e.status === 404 && w.status === 'processing' && !w.cfTransferId) {
      // Cashfree never received it -> safe to retry.
      await store.revertToPending(withdrawalId, 'Transfer was not created at Cashfree; retry approval');
      return { status: 'pending', reverted: true };
    }
    throw e;
  }
}

const rejectWithdrawal = ({ store, withdrawalId, reason, adminUid }) =>
  store.rejectPending(withdrawalId, reason || 'Rejected by admin', adminUid);

/** Pull the transfer id out of any of Cashfree's webhook payload shapes. */
function transferIdFromWebhook(body) {
  const d = (body && (body.data || body)) || {};
  return d.transfer_id || (d.transfer && d.transfer.transfer_id) || body.transfer_id || null;
}
const withdrawalIdFromTransferId = (tid) => (/^WD_(.+)$/.exec(String(tid || '')) || [])[1] || null;

module.exports = {
  classify, resolveInstrument, beneficiaryIdFor, transferIdFor, applyTransfer,
  approveAndPay, syncWithdrawal, rejectWithdrawal,
  transferIdFromWebhook, withdrawalIdFromTransferId,
};
