# Build 13.3 — Payment-first order creation

PAY_NOW now uses a payment attempt/session. No `orders` row is created until server-side payment verification succeeds. PAY_AT_COUNTER continues to create an order immediately. Existing legacy payment endpoints remain compatible with old orders.
