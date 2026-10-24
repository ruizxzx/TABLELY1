

# Build 1+2 Hardening Pass

This revision fixes the following production issues found during code review:

- Product status publish/draft actions now save the intended status without React state-race issues.
- Product removal is server-authorized and order-safe: products with order history are archived; products without order history are deleted and their stored files are cleaned after DB deletion succeeds.
- Bulk product removal uses the same safe server path.
- Product duplication creates a clean draft without sharing storage file paths with the source product; link delivery URLs may be copied because they are external references.
- Existing digital/preview file removal updates the database first, then cleans storage, preventing broken DB references if storage cleanup fails.
- Plan downgrade reconciliation archives newest live categories/products first and restores only within the destination plan's remaining capacity.
- Manually archived content is not automatically restored by plan reconciliation.
- Public category and product reads require live/visible categories and active stores.
- Purchased order items retain delivery snapshots so a plan downgrade/archive does not revoke an existing buyer's delivery path.
- Legacy purchased orders are backfilled with delivery snapshots during migration 010.
- Draft link products may be saved without a link; the link becomes required when publishing.
- Creator Studio can still create drafts after the live-product cap is reached; publishing is what consumes the live allowance.
- Removed an accidental route.tsEOF artifact.

Apply migrations in order through migration 010.

After installation, run locally:

    npm install
    npm run lint
    npm run build

Then test the downgrade/upgrade, safe removal, purchaser access, and public category visibility flows before proceeding to Build 3.

## Build 3 live commerce integration

Required server environment for creator-connected Razorpay OAuth:
- `RAZORPAY_OAUTH_CLIENT_ID`
- `RAZORPAY_OAUTH_CLIENT_SECRET`
- `RAZORPAY_OAUTH_REDIRECT_URI`
- `RAZORPAY_OAUTH_MODE=test|live`
- `RAZORPAY_WEBHOOK_SECRET`
- `SELLORA_PAYMENT_MODEL=creator_connected`

Apply migrations 011 and 012 after the existing Build 1+2 migrations. Creator-connected payments use Razorpay OAuth access tokens server-side and public tokens in Checkout. Do not expose OAuth client secrets or access tokens to the browser.
