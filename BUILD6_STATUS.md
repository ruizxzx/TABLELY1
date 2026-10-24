# Tablely Build 6 — Operations

Implemented in the current codebase.

## Included
- Dedicated kitchen display using ACCEPTED → PREPARING → READY workflow.
- Server-enforced role-aware order transitions.
- Staff management page with invite API, role changes and enable/disable controls.
- Roles: OWNER, MANAGER, WAITER, KITCHEN.
- Realtime notification center with persistent notification history, unread badge, toast popups and browser notifications.
- Customer cancellation requests with restaurant approval/rejection.
- Service-request notification fan-out.
- Authoritative table operational state stored on tables and synchronized from orders/service requests.
- Staff activity/order events remain auditable.

## External requirement
Staff email invitations require `SUPABASE_SERVICE_ROLE_KEY` on the server.
