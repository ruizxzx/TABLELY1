# TABLELY Order Email — Phase 8 Test Matrix

Use a controlled restaurant/table and a test inbox.

| Case | Action | Expected email behavior |
|---|---|---|
| Guest + Counter | Opt in, place order | RECEIVED exactly once |
| Guest + Counter | ACCEPTED | ACCEPTED exactly once |
| Guest + Counter | PREPARING | PREPARING exactly once |
| Guest + Counter | READY | READY exactly once |
| Guest + Counter | COMPLETED | COMPLETED exactly once |
| Pay Now | Complete Razorpay payment with email opt-in | RECEIVED and later statuses exactly once |
| Pay After Delivery | Complete authenticated checkout with email opt-in | RECEIVED and later statuses exactly once |
| Cancellation | Cancel supported test order | CANCELLED exactly once |
| Rejection | Reject supported test order | REJECTED exactly once |
| Repeated status write | Repeat the same status | No duplicate event/email |
| Retry | Force one email delivery failure | Event becomes FAILED, later retry can reach SENT |
| Stale recovery | Leave SENDING event stale | Queue worker recovers to FAILED and retries |
| Multiple restaurant | Repeat with another restaurant/branch | Only that order's recipient receives the email |
| Link | Click View order | Correct order opens; restaurant/table context matches |

## Pass criteria

- No duplicate `(order_id, event_type)` rows.
- Email recipient always matches the subscription email for that order.
- Email contains correct restaurant/order/table/total.
- View order link reaches the matching order page.
- Existing payment/order/session behavior is unchanged.
- Any email delivery failure does not roll back the restaurant order/status transaction.
