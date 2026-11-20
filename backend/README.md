# NGO backend — Cashfree PG + Payouts

Holds the Cashfree secrets so the app never does. Used for:
- **Payment Gateway**: donations, e-commerce checkout, registrations, class & competition fees
- **Payouts**: paying working-member wallet withdrawals to bank / UPI

## Run
```bash
cd backend
npm install
# fill PUBLIC_BASE_URL and FIREBASE_SERVICE_ACCOUNT in .env  (see .env.example)
npm start          # npm test runs the offline unit tests
```
Deploy anywhere with Node 18+ (Railway works: set the same variables, root dir `backend`).
Point the app at it with `EXPO_PUBLIC_API_URL` or `app.json -> expo.extra.API_URL`
(the default is the existing Railway URL, so deploying this service there needs no app change).

`FIREBASE_SERVICE_ACCOUNT`: Firebase console → Project settings → Service accounts → Generate key (paste the JSON on one line, or base64 it).

## Cashfree dashboard setup
| Where | Setting |
|---|---|
| PG → Developers → Webhooks | `https://<PUBLIC_BASE_URL>/api/cashfree/webhook` (payment events) |
| Payouts → Developers → Webhooks | `https://<PUBLIC_BASE_URL>/api/cashfree/payout-webhook` (transfer events) |
| Payouts → Developers → IP whitelist | add this server's outbound IP (Cashfree requires it for Payouts) |
| Payouts → Balance | fund the sandbox/production balance, otherwise transfers fail with insufficient balance |

Webhooks are a speed-up, not the source of truth: the backend always re-reads the order/transfer from Cashfree.
The admin **Check status** button does the same on demand, so a missed webhook never strands a payout.

## Endpoints
| | |
|---|---|
| `POST /api/cashfree/orders` | create order → `{orderId, paymentSessionId}` (rate-limited; uid attached when a Firebase token is sent) |
| `GET  /api/cashfree/orders/:id` | server-verified status; returns a signed receipt when PAID |
| `POST /api/cashfree/verify` | re-verifies `{orderId, paymentId, signature}` against Cashfree |
| `GET  /pay/:orderId?s=` | hosted checkout page used by the native app |
| `POST /api/payouts/withdrawals/:id/approve\|reject\|sync` | **admin only** (Firebase ID token + `users/{uid}.role == 'admin'`) |

## Withdrawal flow
`pending → (admin Approve & Pay) → processing → paid` or `failed` (wallet refunded once).
`Reject` on a pending request also refunds once. All transitions are Firestore transactions, so double-clicks, retries and
repeated webhooks cannot pay or refund twice. Firestore collections used: `withdrawals`, `wallets`, `walletTransactions`, `paymentOrders` (new), `users`.

## Going live
1. Rotate the sandbox keys (they were shared in chat), 2. set `CASHFREE_ENV=production` with live keys,
3. `PUBLIC_BASE_URL` must be https, 4. restrict `CORS_ORIGINS` if you serve the web build.

## Known limits
- Order amount is supplied by the app (screens compute cart totals client-side). The backend verifies that Cashfree collected exactly that amount,
  but for hard guarantees price the cart server-side from the `products` collection.
- Firestore security rules must let admins read `withdrawals`, and should deny client writes to `withdrawals` status fields.
