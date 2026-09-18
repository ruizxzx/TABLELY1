# Tablely Production Runbook

## 1. Environment
Create separate development/staging/production environments and keep server-only secrets out of client bundles.

Required server secrets for restaurant-owned online payments:

- `SUPABASE_SERVICE_ROLE_KEY`
- `TABLELY_ENCRYPTION_KEY` — base64 for exactly 32 bytes

Public values:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_APP_URL`

## 2. Database
Run migrations in order. For the current archive, the new Build 6–10 migration is:

`supabase/migrations/202609141000_build6_10_operations_money_admin.sql`

Do not run production migrations with a reset workflow.

## 3. Super Admin
After the production Tablely administrator account exists, insert that user's UUID into:

`public.platform_admins`

with `active = true`.

## 4. Restaurant staff invitations
Set `SUPABASE_SERVICE_ROLE_KEY` on the server before using `/staff` invite.

## 5. Restaurant online payments
The restaurant owner enables online payments in `/settings/payments` only when the subscription plan permits it.

Enter:

- restaurant Razorpay Key ID
- restaurant Razorpay Key Secret
- restaurant Razorpay Webhook Secret

Secrets are encrypted with `TABLELY_ENCRYPTION_KEY`.

## 6. Verification order
Test:

Customer → Order → Manager Accept → Kitchen Prepare → Kitchen Ready → Waiter Serve → Complete.

Then test cancellation request → manager accept/reject.

Then test Pay at Counter and on-demand online payment.

## 7. Deployment
Deploy only after typecheck/lint/build pass in the real project environment. This archive was parsed for TypeScript/TSX syntax, but a full dependency-backed production build was not available in the sandbox.
