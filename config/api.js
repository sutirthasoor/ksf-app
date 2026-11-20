// config/api.js
// Base URL of the NGO backend (the /backend folder: Cashfree PG + Payouts).
// Override per build with EXPO_PUBLIC_API_URL or app.json -> expo.extra.API_URL.
import Constants from 'expo-constants';

const DEFAULT_API_URL = 'https://ngo-backend-production-25df.up.railway.app';

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ||
  Constants?.expoConfig?.extra?.API_URL ||
  DEFAULT_API_URL
).replace(/\/$/, '');

/** fetch JSON from the backend; throws Error(message) on non-2xx. */
export async function apiFetch(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* non-JSON error page */ }
  if (!res.ok || data.success === false) {
    const err = new Error(data.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
