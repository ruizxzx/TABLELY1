# Sellora V1 Final Status

## Included in this baseline

- Builds 1–3 restored and hardened.
- Creator-connected Razorpay BYOK product commerce.
- Server-side checkout validation, payment verification, webhook processing and idempotent order finalization.
- Purchase-time delivery snapshots and atomic download-limit enforcement.
- Full/refund workflow support inherited from Build 3, with production hardening around state transitions.
- Sellora subscription catalog with Free / Creator / Pro / Max plans.
- Sellora-owned Razorpay subscription billing, separate from creator product-sale credentials.
- Versioned provider plans so pricing changes do not rewrite historical subscription references.
- Admin pricing editor with `Save & Reprovision`.
- Existing paid subscribers can be scheduled onto a newly provisioned price at cycle end.
- Creator billing page with subscription state, plan changes, cancellation/resume, sync, payment history and invoice IDs.
- Subscription webhooks with signature verification and event idempotency.
- Subscription renewal/failure/cancellation email workflows.
- Scheduled billing/trial housekeeping endpoint and Vercel Cron configuration.
- Admin access/trials precedence integrated with the entitlement engine.
- Build 5 security headers, Sentry wiring, health endpoint and production runbook.
- Service-only access to encrypted payment credential tables.
- Hardened SECURITY DEFINER usage and deterministic search paths for relevant functions.

## Plan pricing control

The customer-facing price is read from `public.sellora_plans`.

For paid plans, Admin → Subscriptions → Save & Reprovision:

1. validates the new INR price;
2. creates a new local plan version;
3. creates a new Razorpay plan through the Sellora billing account;
4. retires the previous current provider-plan version;
5. makes the new provider plan current;
6. updates the public catalog price;
7. schedules existing subscribers on that plan to move at cycle end;
8. records the administrative action in billing/audit tables.

Historical subscription records continue to reference the provider plan/version under which they were created.

## Remaining external launch actions

Application/database code is included, but public production still requires external configuration and real-world verification:

- enable Supabase Auth leaked-password protection;
- configure live Sellora-owned Razorpay credentials and subscription webhook;
- configure creator-connected Razorpay credentials/webhook behavior;
- configure Resend/domain sender;
- set the final admin allow-list and cron secret;
- set production Supabase/app URLs and secret values;
- configure custom domain/HTTPS and backups;
- run the full Build 3/4/5 acceptance matrix with Razorpay test mode before switching to live mode.
