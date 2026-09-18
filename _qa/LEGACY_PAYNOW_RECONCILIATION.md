# Build 17 — Legacy PAY_NOW reconciliation

This additive patch handles old orders created before payment-first order creation was enforced.

Eligible legacy records are marked at migration time only when they already have:
- `payment_method = PAY_NOW` (or `PAY_NOW:*`)
- `payment_status = PENDING`
- `status = SERVED` or `COMPLETED`

Authorized payment staff can explicitly reconcile those records as CASH/UPI/CARD. The order's historical status is preserved; only the outstanding payment state is settled and the legacy flag is cleared. New PAY_NOW orders cannot opt into this exception path.

Normal PAY_NOW orders remain online-payment-only. PAY_AT_COUNTER continues through the existing counter settlement path.
