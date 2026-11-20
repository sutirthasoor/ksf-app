// services/paymentService.js
// Cashfree Payment Gateway integration (donations, e-commerce, registrations, classes).
//
// SECURITY MODEL: no Cashfree secret ever ships in the app. The app asks the backend (/backend)
// to create an order, the user pays on Cashfree's checkout, and the backend is the only party that
// confirms the payment (it re-reads the order from Cashfree). Success is only reported to screens when
// the backend says PAID.
//
// The exported function names (initiateRazorpayPayment, ...) are kept so existing screens keep working;
// Cashfree-named aliases are exported as well.
import { Platform, Linking, AppState } from 'react-native';
import { API_URL, apiFetch } from '../config/api';
import { getAuthInstance } from '../config/firebase';

const log = (...a) => { if (__DEV__) console.log('💳 [payment]', ...a); };

const authToken = async () => {
  try { return (await getAuthInstance()?.currentUser?.getIdToken()) || undefined; } catch (_) { return undefined; }
};

// ============================================
// BACKEND CALLS
// ============================================

/** Create a Cashfree order via the backend. */
export const createRazorpayOrder = async (amount, currency = 'INR', extra = {}) => {
  const value = Math.round(parseFloat(amount) * 100) / 100;
  if (!Number.isFinite(value) || value < 1) throw new Error('Minimum amount is ₹1');
  const data = await apiFetch('/api/cashfree/orders', {
    method: 'POST',
    token: await authToken(),
    body: {
      amount: value,
      purpose: extra.purpose || 'donation',
      description: extra.description,
      customer: { name: extra.name, email: extra.email, phone: extra.phone },
    },
  });
  return {
    orderId: data.orderId,
    paymentSessionId: data.paymentSessionId,
    amount: data.amount,
    currency: data.currency,
    env: data.env,
    status: 'created',
    createdAt: new Date().toISOString(),
  };
};

/** Server-side truth about an order. */
const fetchOrderStatus = async (orderId) => {
  try {
    return await apiFetch(`/api/cashfree/orders/${encodeURIComponent(orderId)}`);
  } catch (e) {
    log('status check failed', e.message);
    return null;
  }
};

/** Ask the backend to confirm the payment (re-checks Cashfree + verifies the server-issued receipt). */
export const verifyRazorpayPayment = async ({ paymentId, orderId, signature }) => {
  try {
    const data = await apiFetch('/api/cashfree/verify', {
      method: 'POST',
      body: { paymentId, orderId, signature },
    });
    return { success: !!data.success, message: data.message };
  } catch (e) {
    return { success: false, message: e.message || 'Verification failed' };
  }
};

// ============================================
// RESULT HELPERS
// ============================================

const successResult = (status, order, p) => {
  const result = {
    success: true,
    paymentId: status.paymentId,
    orderId: order.orderId,
    signature: status.signature, // server-issued receipt; checked again by verifyRazorpayPayment
    amount: status.amount,
    name: p.name,
    email: p.email,
    phone: p.phone,
    gateway: 'cashfree',
    timestamp: new Date().toISOString(),
  };
  if (typeof global.paymentDetails === 'undefined') global.paymentDetails = {};
  if (typeof global.payments === 'undefined') global.payments = [];
  if (typeof global.donationHistory === 'undefined') global.donationHistory = [];
  global.paymentDetails[result.paymentId] = result;
  global.payments.push(result);
  global.donationHistory.push({ ...result, verified: true, verifiedAt: result.timestamp });
  return result;
};

const cancelled = () => ({ success: false, error: 'Payment was cancelled', code: 'PAYMENT_CANCELLED' });
const failed = (error) => ({ success: false, error: error || 'Payment failed', code: 'PAYMENT_FAILED' });

// ============================================
// WEB: Cashfree JS SDK modal
// ============================================

const loadCashfreeSdk = () =>
  new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.Cashfree) return resolve(window.Cashfree);
    const s = document.createElement('script');
    s.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
    s.async = true;
    s.onload = () => (window.Cashfree ? resolve(window.Cashfree) : reject(new Error('Cashfree SDK failed to initialise')));
    s.onerror = () => reject(new Error('Failed to load Cashfree SDK'));
    document.head.appendChild(s);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const initiateWebPayment = async (p, order) => {
  const Cashfree = await loadCashfreeSdk();
  const cashfree = Cashfree({ mode: order.env === 'production' ? 'production' : 'sandbox' });
  const result = await cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: '_modal' });

  let status = await fetchOrderStatus(order.orderId);
  // UPI/netbanking can confirm a few seconds after the modal closes
  for (let i = 0; i < 6 && result?.paymentDetails && !status?.paid; i++) {
    await sleep(3000);
    status = await fetchOrderStatus(order.orderId);
  }
  if (status?.paid) return successResult(status, order, p);

  const msg = `${result?.error?.code || ''} ${result?.error?.message || ''}`.toLowerCase();
  if (!result?.error || /close|cancel|dismiss/.test(msg)) return cancelled();
  return failed(result.error.message);
};

// ============================================
// NATIVE: hosted checkout in the system browser + server-side confirmation
// ============================================
// (No native SDK needed, so it works in Expo dev builds without extra native modules.)

const waitForNativePayment = (order, p) =>
  new Promise((resolve) => {
    let done = false;
    let wentToBackground = false;
    let graceTimer = null;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(hardTimeout);
      clearTimeout(graceTimer);
      sub?.remove?.();
      resolve(result);
    };

    const check = async () => {
      const s = await fetchOrderStatus(order.orderId);
      if (done || !s) return;
      if (s.paid) finish(successResult(s, order, p));
      else if (['EXPIRED', 'TERMINATED', 'AMOUNT_MISMATCH'].includes(s.status)) finish(failed(`Payment ${s.status.toLowerCase()}`));
    };

    const poll = setInterval(check, 3000);
    const hardTimeout = setTimeout(() => finish(failed('Payment timed out. If money was deducted it will be reconciled automatically.')), 15 * 60 * 1000);

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') wentToBackground = true;
      if (state === 'active' && wentToBackground) {
        check();
        clearTimeout(graceTimer);
        // user came back: give the gateway a moment to confirm, then treat as cancelled
        graceTimer = setTimeout(async () => { await check(); finish(cancelled()); }, 15000);
      }
    });
  });

const initiateNativePayment = async (p, order) => {
  const url = `${API_URL}/pay/${encodeURIComponent(order.orderId)}?s=${encodeURIComponent(order.paymentSessionId)}`;
  await Linking.openURL(url);
  return waitForNativePayment(order, p);
};

// ============================================
// MAIN ENTRY
// ============================================

export const clearPaymentState = () => {
  global.payments = [];
  global.paymentDetails = {};
  global.donationHistory = [];
  global.orders = {};
  delete global.lastOrderId;
};

export const initiateRazorpayPayment = async (paymentData) => {
  clearPaymentState();
  try {
    const order = await createRazorpayOrder(paymentData.amount, 'INR', {
      name: paymentData.name,
      email: paymentData.email,
      phone: paymentData.phone,
      description: paymentData.description,
      purpose: paymentData.purpose,
    });
    global.lastOrderId = order.orderId;
    log('order created', order.orderId, Platform.OS);
    return Platform.OS === 'web'
      ? await initiateWebPayment(paymentData, order)
      : await initiateNativePayment(paymentData, order);
  } catch (error) {
    log('payment error', error.message);
    return failed(error.message);
  }
};

// ============================================
// IN-SESSION HISTORY HELPERS (unchanged contract)
// ============================================

export const getDonationHistory = () => global.donationHistory || [];
export const getDonationById = (paymentId) => global.paymentDetails?.[paymentId] || null;
export const getTotalDonations = () =>
  getDonationHistory().reduce((total, d) => total + (Number(d.amount) || 0), 0);
export const getDonationCount = () => getDonationHistory().length;
export const getAllPayments = () => global.payments || [];
export const clearPaymentData = clearPaymentState;

export const isProduction = () => false; // environment is decided by the backend (CASHFREE_ENV)
export const getEnvironment = () => 'backend';
export const getRazorpayKey = () => null; // no client-side key with Cashfree
export const hasValidKeys = () => !!API_URL;

// Cashfree-named aliases for new code
export const initiateCashfreePayment = initiateRazorpayPayment;
export const verifyCashfreePayment = verifyRazorpayPayment;
export const createCashfreeOrder = createRazorpayOrder;

export default {
  initiateRazorpayPayment,
  verifyRazorpayPayment,
  createRazorpayOrder,
  initiateCashfreePayment,
  verifyCashfreePayment,
  createCashfreeOrder,
  getDonationHistory,
  getDonationById,
  getTotalDonations,
  getDonationCount,
  getAllPayments,
  clearPaymentData,
  clearPaymentState,
  isProduction,
  getEnvironment,
  getRazorpayKey,
  hasValidKeys,
};
