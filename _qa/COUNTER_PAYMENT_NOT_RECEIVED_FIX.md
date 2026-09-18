# Counter Payment Not Received Fix

## Root cause

`decide_counter_payment(..., p_received=false)` correctly set the order to `CANCELLED` and used the intended `COUNTER_PAYMENT_NOT_RECEIVED` cancellation reason, but the `orders_cancellation_reason_check` constraint did not allow that code. PostgreSQL therefore rejected the update with SQLSTATE 23514 and the API returned HTTP 400.

## Fix

The additive migration `202609190001_build21_counter_payment_cancellation_reason.sql` adds `COUNTER_PAYMENT_NOT_RECEIVED` to the existing allowed cancellation reasons and updates the server-side label helper used by cancellation notifications.

## Expected behavior

Manager clicks `Not received` -> order becomes `CANCELLED` -> cancellation reason is `COUNTER_PAYMENT_NOT_RECEIVED` -> customer order page recognizes the reason and displays the existing customer-facing payment-not-received cancellation message.

No payment, menu, cart, session, or Pay After Delivery behavior is changed.
