# TABLELY Build 31.7 — Orders-Centric Session Management

## Included

- Added active-session and ready-to-close groups to Orders without removing the Tables workflow.
- Added session details from the session ID on an order card, including customer/session information, orders, payment history, and collected/outstanding totals.
- Added explicit closure confirmation and a fresh server readiness check before the existing close-session RPC is called.
- Session-management errors now display Supabase/PostgREST's actual `message` instead of a generic fallback, including failures when the session details drawer cannot load.
- Added a branch-authorized `get_table_session_management` RPC that reports blockers for active orders, unpaid orders, unresolved cancelled/rejected order payments, pending payment verification, and unresolved service requests.
- Strengthened the transactional close core to recheck payment and order state, record `closed_by`, close only the requested session, release only its assigned seats, and recalculate table availability across remaining sessions.
- Added regression tests for the Orders entry points, server-derived readiness/authorization, and independent concurrent sessions on one physical table.
- Added a top-bar live chat panel with an unread count, realtime thread list and replies, in-app/browser notifications, and Orders-card alerts for the exact table session.
- Added session-token-hash linking between chat conversations and table sessions. Closing a session closes and removes its conversation from active inboxes; the persisted messages remain unavailable through chat APIs after closure.
- Orders now defaults to today's orders and supports last-7-day, last-30-day, and custom inclusive date ranges. Matching orders and their items load in pages, and each order card shows its local order date/time alongside elapsed time.
- Added a manager-authorized, reason-required force-close path for sessions blocked only by cancelled/rejected order payment review. The override records the actor, reason, and affected order/payment snapshot; it does not alter payment records and cannot bypass active unpaid orders, pending payment verification, active orders, or unresolved service requests. Cancelling an order still does not automatically close the session, so same-visit reorders remain linked until an authorized person explicitly closes that visit.
- Compactly reorganized Orders into two columns at standard desktop widths and three on wide screens, tightened order/session card spacing, kept status filters horizontally scrollable on narrow screens, and prevented status badges and priority labels from stretching.
- Redesigned the Orders session manager as a live, prioritized compact roster with Realtime connection state and polling fallback, an at-a-glance ready/in-progress/outstanding summary, session age, order/active counts, collected and outstanding amounts, and visible closure blockers. Desktop session cards use a dense horizontal layout; narrow layouts stack the same information without horizontal overflow.
- Order badges now use a red crossed-out label and X icon for cancelled orders, green with a check for completed orders, and neutral gray with a ban icon for rejected orders.
- Added a persistent mobile operations bar for Orders, Tables, Kitchen, and Service, plus a More drawer containing all role- and permission-filtered navigation routes. The collapsed desktop rail becomes an off-canvas drawer on narrow screens so page content can use the full viewport.
- Reworked the notification and customer-chat overlays for mobile: both render outside the sticky header, use safe-area-aware sheets above the bottom navigation, and keep their own content scrollable. Chat switches between a full-width conversation list and thread with a Back control; notification history expands to use the available sheet height, with larger touch targets and mobile-positioned toasts.
- Tightened shared card spacing and improved mobile touch targets for compact buttons, icon buttons, order actions, and status filters. This is the shared operations UI foundation for the broader mobile-first refresh.
- Mobile data tables now preserve all columns and provide horizontal scrolling instead of hiding columns on small screens.

## Deployment and permissions

Apply `supabase/migrations/20261024100000_build317_orders_session_management.sql` after the existing project migrations. Session inspection and closure require the caller to have the branch-level `EDIT_ORDERS` permission. The Orders UI currently presents session management to restaurant owners and managers; database permission checks remain authoritative.

For the session-linked live inbox, apply `supabase/migrations/20261024110000_build317_live_session_customer_chat.sql` after the Build 31.6 chat migration and Build 31.7 session migration. For the audited cancelled-order closure override, apply `supabase/migrations/20261024120000_build317_audited_cancelled_session_close.sql` after the session-management migration. Staff inbox access is branch-scoped; owners, managers, and waiters have access subject to the resolved branch context.

No migration was applied during this task. Verify the migrations against the target Supabase schema and test private Broadcast authorization, message delivery, unread state, payment verification, concurrent closure, and table occupancy behavior in staging before deployment. No new environment variables or external provider configuration are required.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript typecheck | PASS | `node .\node_modules\typescript\bin\tsc --noEmit` |
| Latest focused regression run | PASS | `node --experimental-strip-types --test tests/build31_7-session-ops.test.mjs tests/build31_7-live-chat.test.mjs tests/orders-date-range.test.mjs tests/studio-shell-sidebar.test.mjs` (11 tests) |
| Session manager redesign regression run | PASS | `node --experimental-strip-types --test tests/build31_7-session-ops.test.mjs` (6 tests) |
| Focused session, live-chat, and sidebar regression tests | PASS | `node --experimental-strip-types --test tests/build31_7-live-chat.test.mjs tests/build31_7-session-ops.test.mjs tests/studio-shell-sidebar.test.mjs` (7 tests) |
| Orders date-range regression tests | PASS | `node --experimental-strip-types --test tests/orders-date-range.test.mjs` |
| Session, live-chat, date-filter, and audited close-override regression tests | PASS | `node --experimental-strip-types --test tests/build31_7-session-ops.test.mjs tests/build31_7-live-chat.test.mjs tests/orders-date-range.test.mjs` (10 tests) |
| Configured full test suite | FAIL (pre-existing failures) | 83 of 86 passed. Failures: historic migration timestamp validation and two Build 32 contract tests (WhatsApp STOP consent revocation and the AI-translation toggle contract). |
| Migration version preflight | FAIL (pre-existing migration filenames) | Duplicate historical versions and invalid historic filenames; the new Build 31.7 migration versions are valid and ordered. |
| ESLint on changed TS/TSX files | FAIL (existing configuration issue) | ESLint 9.39.5 failed loading the project config with a circular-structure `TypeError`. |
| Migration execution / live permission and concurrency tests | NOT RUN | The audited cancelled-order override migration has not been applied to a database. |
| Browser smoke test | PASS (limited) | Authenticated local Orders page showed the popup inbox, two active conversations, and a live Realtime connection. No messages were sent or marked read during the check. |
| Compact Orders responsive layout | PASS | Browser-checked at 1106px and 390px: two-column desktop order cards, single-column narrow cards, readable status badge sizing, horizontally scrollable status filters, and no page-level horizontal overflow. |
| Compact session roster and Realtime state | PASS | Authenticated browser check showed a live subscription, ready/in-progress status, session age and financial/order metrics. At 1106px, the roster fit one 65px session row inside the panel; at 390px, the session content stacked with no page-level or card overflow. |
| Mobile operations navigation | PASS | At 390px the primary bar showed Orders, Tables, Kitchen, Service, and More with no page-width overflow; More opened the full text-labeled navigation list of all 20 role-available routes. |
| Mobile notification and chat panels | PASS | At 390×844, the notification panel and chat sheet fit between the 64px top bar and bottom navigation without document-width overflow. Chat list/thread switching and return to conversations were exercised; focused mobile-panel and live-chat tests passed (4/4). |
| Order status visual states | PASS | Regression checks cover cancelled red/crossed/X, completed green/check, and rejected gray/Ban-icon treatments. |
| Mobile information availability | PASS | Data-table regression verifies that all columns remain present and scroll horizontally on narrow screens instead of being hidden. |
| Production build | NOT RUN | Typecheck and focused regression tests were run; no production build was attempted. |

## Release archive

`TABLELY_BUILD_31_7_COMPLETE.zip` is the versioned delivery archive. It includes project source, migrations, tests, lockfile, configuration templates, and this report while excluding dependencies, build caches, local environment files, and nested release archives. Build 31.6's archive is preserved unchanged.
