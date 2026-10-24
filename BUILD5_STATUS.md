# Tablely Build 5 — Realtime Operations

Implemented on top of Builds 1–4.

## Realtime
- Branch-scoped Supabase Postgres Changes for restaurant orders.
- Branch-scoped realtime for kitchen orders and service requests.
- Customer-safe Broadcast topic per opaque tracking token.
- Sanitized customer broadcast payload (status/payment status/update timestamp only).
- Live/reconnecting/offline indicators.
- Reconnect snapshot reconciliation.
- 20-second fallback refresh while realtime is unavailable.

## Order state
- Explicit NEW → ACCEPTED → PREPARING → READY → SERVED → COMPLETED flow.
- Server-side transition validation remains authoritative.
- Concurrent updates use row locking in the RPC.
- Order event history records status transitions and actor IDs.

## State consistency
- Stable ID upserts for realtime events.
- Duplicate order/order-item/service-request prevention.
- Load sequence guards prevent stale async loads overwriting newer state.
- Realtime INSERT fetches only the new order's items.
- UPDATE/DELETE events reconcile local state without full-page refresh.

## Customer tracking
- Live order-status updates without manual refresh.
- Read-only customer view retained.
- Fallback refresh while disconnected.

## Kitchen
- Live NEW/PREPARING/READY order feed.
- Live order item loading on INSERT.
- Sound notification remains optional and failure-safe.

## Verification
- Source was statically inspected after the changes.
- Full npm/Next.js production compilation still requires a local environment with dependencies installed because sandbox npm installation times out.
