# TABLELY BUILD 13.4 STATUS

Scope: realtime + notifications + customer/restaurant UX.

Implemented:
- Owner branch-level notification preferences, defaulting new/unconfigured branches to disabled.
- Owner notifications are delivered organization-wide only for explicitly enabled branches.
- Manager/Waiter/Kitchen notification recipients remain branch-scoped.
- Notification history is filtered to the same branch scope used by live delivery.
- Notification unread count uses an exact server count for the current scope.
- Notification inserts are deduplicated client-side to avoid duplicate toast/count effects.
- Notification center reconnect/visibility/online fallback handling.
- Order status/payment realtime customer reload reconciliation on broadcasts and browser reconnect/visibility.
- Customer acceptance label clarified to "Order Accepted".
- Service-request notifications now use the scoped notification helper so Owner preferences apply consistently.
- Owner-only route guard for notification settings.

Preserved:
- Build 13.2 authorization/security model.
- Build 13.3 payment/order core and Razorpay flow.
- Existing cancellation-request realtime fix.
- Existing branch/date order numbering and payment-first architecture.

Validation:
- All 97 TS/TSX source files parsed successfully with the installed TypeScript parser.
- All changed TS/TSX files passed TypeScript syntax transpile checks.
- Build 13.4 SQL migration structural validation passed; dollar-quote delimiters balanced and required statements present.
- Full npm build/typecheck/lint and live Supabase/Razorpay integration tests were not available in this sandbox because project dependencies could not be installed before timeout and no live database credentials were connected.
