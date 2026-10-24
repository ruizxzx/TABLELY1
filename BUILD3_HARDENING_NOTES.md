# Sellora Build 3 Hardening Export

## Scope
Targeted hardening of the Build 3 commerce chain identified in the accompanying audit. Existing working product/storefront functionality was preserved; changes are limited to the audited payment, checkout, order, delivery, webhook, migration, and security paths.

## Main fixes
- Canonical migration sequence through `015`, with refund/finance reconciliation at `014`.
- Plan restoration occurs only on a true plan upgrade (`new_rank > old_rank`).
- New upload products use draft -> upload -> validate -> live ordering.
- Razorpay Build 3 uses API credentials only; OAuth fallback is disabled.
- Razorpay payment accounts are versioned with an explicit current account; historical accounts remain available for historical order/refund associations.
- Checkout cancellation tokens are returned to the buyer but only their SHA-256 hashes are stored.
- Bundle checkout validates every constituent item and rejects the whole bundle if any item is invalid/offline/incompatible.
- Payment finalization uses an atomic paid-state claim so duplicate payment/webhook delivery does not repeat order-side effects.
- Purchased delivery configuration is snapshotted in `order_items`.
- Download limits and expiry are enforced from the order-item snapshot with an atomic row-locking claim.
- Webhook fallback event IDs are derived from the raw event body; late failure/processing events cannot overwrite terminal orders.
- The public product view is consolidated into a safe projection that does not expose private delivery fields.

## Validation performed
- All 96 TypeScript/TSX source files parsed with zero syntax diagnostics.
- Edited TypeScript files passed a semantic compiler check using temporary local declaration shims.
- Migration sequence and key payment/security/idempotency invariants were checked statically.
- No live Supabase migrations were applied from this export.
- `.env.local` is excluded from the release ZIP; `.env.example` is retained.

## Release gate still required
A dependency-backed `npm build`/lint could not be completed in this execution environment because the full dependency tree could not be installed from the available npm cache. Before production deployment, run the normal build/lint, apply migrations to a staging Supabase database, and execute Razorpay sandbox integration/replay tests covering payment success/failure, duplicate webhooks, refunds, account reconnect/disconnect, and secure download behavior.
