# Tablely Build 10 — Production Preparation

## Included
- Production-aware environment separation guidance.
- Server-only secret boundaries.
- Encrypted restaurant payment-secret architecture.
- Production security headers.
- Health/readiness endpoint.
- Deployment and migration documentation.
- Realtime production-readiness checks documented.
- Payment production-readiness checks documented.
- Backup/recovery and incident-response runbook.
- Build 6–10 documentation included in this archive.

## Not claimed as completed
No live deployment, live Razorpay configuration, production Supabase migration, DNS setup or real-restaurant pilot was performed in this environment.


## Post-test fixes
- Staff invitations now fall back to a secure 7-day invitation link when Supabase Admin email configuration is unavailable; the email/admin path remains available when configured.
- Pending cancellation requests are automatically resolved when an order becomes non-cancellable, and stale requests are backfilled as rejected.
- Cancellation decision calls no longer leave stale pending requests behind when the order has already moved to SERVED/COMPLETED/CANCELLED.
