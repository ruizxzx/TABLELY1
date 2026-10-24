# TABLELY Build 27 — Regression Test Matrix

This matrix records required regression coverage. Unit tests added with Build 27 are executable locally. Database-backed, browser-based, Razorpay sandbox and production checks require the corresponding local Supabase stack, browser runner, test credentials or deployed environment; they must not be reported as passed unless actually executed.

## Dashboard and financial aggregation

| Scenario | Expected result | Execution status |
|---|---|---|
| Paid Razorpay order with CAPTURED ledger row | Count once in gross and net collected | Not run — DB unavailable |
| Manual counter payment with PAID ledger row | Count once in gross and net collected | Not run — DB unavailable |
| Unpaid PAY_LATER order | No revenue; full balance outstanding | Not run — DB unavailable |
| Failed/rejected/cancelled unpaid order | No revenue; no active outstanding | Not run — DB unavailable |
| Partially collected order | Count collected amount; remaining balance outstanding | Not run — DB unavailable |
| Full refund represented in ledger | Net collected equals zero | Not run — DB unavailable |
| Legacy REFUNDED order with captured ledger row but no refund row | Order-state fallback reports the full refund | Not run — DB unavailable |
| Legacy PAID/REFUNDED order with failed-only transaction rows | Compatibility fallback avoids missing/negative revenue | Not run — DB unavailable |
| More than 50 orders in one branch business day | Summary includes every qualifying order | Not run — DB unavailable |
| Branch timezone differs from browser timezone | Summary and recent-order preview use branch business date | Not run — DB unavailable |
| Unauthorized branch / staff without ANALYTICS | RPC rejects access | Not run — DB unavailable |

## Razorpay verification and webhook safety

| Scenario | Expected result | Execution status |
|---|---|---|
| Valid captured INR payment | Verify amount/order/currency and settle once | Not run — Razorpay sandbox unavailable |
| Invalid checkout signature | Reject; no order settlement | Not run — Razorpay sandbox unavailable |
| Wrong order ID, amount or currency | Reject; no order settlement | Not run — Razorpay sandbox unavailable |
| Authorized but uncaptured payment | Do not settle | Not run — Razorpay sandbox unavailable |
| Duplicate checkout verification | Return existing result; no duplicate order/ledger entry | Not run — DB/Razorpay unavailable |
| Duplicate captured webhook | Idempotent finalization | Not run — DB/Razorpay unavailable |
| Duplicate failed webhook | No duplicate financial effect | Not run — DB/Razorpay unavailable |
| Failure event after successful settlement | Paid order remains paid | Not run — DB/Razorpay unavailable |
| Webhook before browser callback | Webhook finalizes; callback returns existing result | Not run — DB/Razorpay unavailable |
| Browser callback before webhook | Callback finalizes; webhook returns existing result | Not run — DB/Razorpay unavailable |
| Browser closes after payment | Signed captured webhook can still finalize | Not run — DB/Razorpay unavailable |
| Concurrent payment-order creation requests | One stored Razorpay order per attempt/legacy order | Not run — DB/Razorpay unavailable |
| Stale request attempts to save/release after lease expiry | UUID fencing token prevents changing a newer lease | Not run — DB unavailable |
| Webhook finalizes before browser verify callback | Callback returns the same completed order for matching stored payment IDs | Not run — DB/Razorpay unavailable |

## Customer visit/session regression

| Scenario | Expected result | Execution status |
|---|---|---|
| Scan QR without ordering | No persistent table session created | Not run — browser/DB unavailable |
| Same tab refresh | Same visit context retained | Not run — browser unavailable |
| Duplicate a browser tab | New `window.name` context and isolated cart/visit token | Not run — browser unavailable |
| Two customers at same table | Independent visits and carts | Not run — browser/DB unavailable |
| Clear one tab cart | Does not clear another visit's cart | Not run — browser unavailable |
| Customer A leaves; Customer B starts new visit | New visit token; prior server session/order unaffected | Not run — browser/DB unavailable |
| New PAY_NOW order | Session creation remains tied to successful payment/order finalization | Not run — DB unavailable |

## RLS and permissions

| Scenario | Expected result | Execution status |
|---|---|---|
| `anon` reads payment_transactions | Denied | Not run — DB unavailable |
| `authenticated` reads/writes payment_transactions directly | Denied | Not run — DB unavailable |
| `service_role` processes payment RPC | Allowed | Not run — DB unavailable |
| Owner reads branch dashboard metrics | Allowed | Not run — DB unavailable |
| Staff with branch ANALYTICS permission | Allowed | Not run — DB unavailable |
| Staff without branch ANALYTICS permission | Denied | Not run — DB unavailable |
| User from restaurant A requests restaurant B branch metrics | Denied | Not run — DB unavailable |

## Build commands

| Command | Expected result | Execution status |
|---|---|---|
| `npm test` | Unit and migration-integrity tests pass | PASS — 13 tests |
| `npm run check:migrations` | No migration-version collisions | PASS — 131 unique numeric versions |
| `npm run typecheck` | No TypeScript errors | Blocked — dependencies unavailable |
| `npm run lint` | No lint errors | Blocked — dependencies unavailable |
| `npm run build` | Production build completes | Blocked — dependencies unavailable |
| Supabase migration validation | Build 27 migration applies in a disposable DB | Blocked — Supabase CLI/DB unavailable |

## Migration history gate

The original `202609180031` timestamp collision is resolved in the local repository through unique-version, idempotent reconciliation migrations. Before remote deployment, inspect the target project's `supabase_migrations.schema_migrations` ledger and stage the full chain. A read-only dashboard metrics smoke test is available at `supabase/verification/build27_dashboard_metrics_smoke.sql`.
