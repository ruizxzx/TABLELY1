# Sellora Build 3 — Razorpay BYOK

Creator payment connection currently uses Bring Your Own Razorpay API Credentials. OAuth is intentionally deferred.

Required server secret:

`SELLORA_PAYMENT_ENCRYPTION_KEY` — a 32-byte key represented as 64 hex characters or base64. Generate locally with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Creators connect using their Razorpay Key ID and Key Secret. The secret is verified server-side and stored encrypted in `payment_account_credentials`. An optional per-creator webhook secret may also be stored encrypted.

For local/test mode, use `rzp_test_...` credentials and keep `PAYMENTS_LIVE_ENABLED=false`. Live keys are rejected until `PAYMENTS_LIVE_ENABLED=true`.
