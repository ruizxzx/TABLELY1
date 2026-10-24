# Build 31.6 customer-to-restaurant messaging

The public ordering page has a persistent **Message** button. Customers can open a private conversation while continuing to browse the menu; restaurant owners, managers, and waiters can reply from **Customer messages** in the restaurant dashboard or from the live-chat panel in the restaurant top bar.

## Data and access

- Conversations are identified by a per-tab visit token hash and table ID, not by table ID alone.
- Opening a conversation does not create or occupy a table session.
- The API returns a random private-channel key only after validating the visit token.
- Messages are persisted in PostgreSQL; database triggers publish committed message/status events to private Supabase Realtime channels.
- Customer API access requires the same visit token. Staff API access is restricted to the active restaurant branch resolved from the signed-in staff account.
- The customer conversation records and messages are separate from TABLELY support tickets.
- Conversations expire after 24 hours. The visit token remains in the existing visit context; starting a new visit creates a different chat identity.
- Build 31.7 links a conversation to the exact table session by its visit-token hash when the first order associates the visit with a session. Closing that session closes the conversation and removes it from the active restaurant inbox. Stored messages are retained for audit/history but closed threads cannot be reopened or fetched through customer/staff chat APIs.

## Build 31.7 live inbox

- The top-bar **Customer messages** control opens the live inbox without leaving Orders. The count shows unread guest messages; new messages also show an in-app toast and request the existing browser notification when permitted.
- The inbox is branch-scoped and uses the existing private `tablely:customer-inbox:<branch-id>` Broadcast channel. Opening a thread marks its unread count as read for the restaurant team, and incoming/outgoing messages remain persisted in the original conversation tables.
- Orders cards show a **new message** alert for the exact linked table session. Clicking it opens the matching thread in the top-bar panel.
- Apply `supabase/migrations/20261024110000_build317_live_session_customer_chat.sql` after the Build 31.6 chat migration and Build 31.7 session management migration.

## Database setup

Apply `supabase/migrations/20261024090000_build316_customer_restaurant_chat.sql` to a development or staging Supabase project after the repository's preceding migrations. For the Orders-centric live inbox, also apply `supabase/migrations/20261024110000_build317_live_session_customer_chat.sql` after the session-management migration. These migrations are additive and are not applied to any hosted database by this code change.

Supabase Realtime must be enabled for private Broadcast channels. The migration adds topic authorization policies for customer conversation channels and active staff branch inbox channels. No customer-message tables are added to the public Realtime publication.

## Current scope and limitations

This implements text messaging, private Broadcast delivery, idempotent client message IDs, persistent history, branch-scoped staff replies, and reconnect/focus catch-up. The customer chat does not yet include typing indicators, Presence, read receipts, attachments, or email/WhatsApp notifications. Those are not represented as working features in this UI.

Run the focused local contract tests with:

```powershell
node --experimental-strip-types --test tests\build31_6-support.test.mjs
```

End-to-end Realtime authorization and multi-visitor isolation still require a Supabase staging project and separate browser contexts.
