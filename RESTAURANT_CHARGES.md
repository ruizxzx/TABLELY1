# Restaurant Checkout Charges

Owners can configure optional GST/tax, platform/service fees, and other named charges at `/settings/charges`.

Enabled charges are calculated server-side from the current order subtotal and persisted on the order. The same final total drives Razorpay amount, pay-at-counter collection, bills, payment history, analytics, manager order views, and customer order tracking.

Percentage and fixed charges are supported. Charges are calculated independently against subtotal; they are not compounded on each other.
