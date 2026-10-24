# TABLELY BUILD 11 STATUS

## Implemented

- Final plan catalog prices: ₹499 / ₹999 / ₹1,999
- 14-day plan-specific trial model
- Central entitlement model
- Server-side plan checks
- Starter staff-limit protection
- Starter online-payment protection
- Service-request entitlement protection
- Restaurant subscription page
- Super Admin plan catalog page
- Tablely SaaS Razorpay subscription API layer
- Subscription checkout verification
- Subscription webhook endpoint and idempotency storage
- Plan change/cancellation RPCs and APIs
- Subscription payment ledger foundation
- Provider invoice fetch support
- Existing Build 10 restaurant/admin flows preserved in source

## Tested

- `npm run typecheck` passes with installed dependencies
- `npm run build` passes all application routes
- `supabase db push` and `supabase migration list` match the linked project
- `supabase db lint --linked` reports no schema errors
- Live RPC signature, catalog pricing, subscription snapshot columns, RLS policy and PRO entitlement queries were exercised against the linked project
- Razorpay restaurant-payment flow was manually verified by the user before Build 11 changes

## Not fully verified

- `npm run lint` is unavailable because this repository has no lint script or ESLint configuration
- Tablely SaaS Razorpay checkout, provider plan provisioning and webhook delivery require external test credentials
- Full browser regression and cross-tenant authorization testing require authenticated test users for each role

## User intervention required

- Add separate `TABLELY_RAZORPAY_*` server credentials for SaaS billing.
- Provision the three Tablely Razorpay plans from Super Admin → Manage plans.
- Configure the deployed `/api/subscriptions/webhook` endpoint in Razorpay.
- Perform final Test Mode and production credential/device testing.
