# TABLELY Phase 5 Release Notes

## Scope

Phase 5 is deliberately non-invasive. It adds:

- a production activation runbook;
- a read-only Supabase readiness query;
- read-only event/dispatch inspection queries;
- a no-privilege web API smoke-test script.

## Existing code preservation

No existing TABLELY application, payment, session, menu, order lifecycle, or customer email implementation was rewritten as part of Phase 5.

## Live infrastructure observed during Phase 5 preparation

The live Supabase project was checked for the Phase 4 prerequisites. At the time of preparation:

- Vault project URL secret: present and non-empty
- Vault service-role dispatch secret: present and non-empty
- `pg_net`: installed
- `pg_cron`: installed
- `tablely-order-email-dispatch`: active
- order-status email trigger: present
- subscription email seed trigger: present
- `(order_id, event_type)` uniqueness protection: present

Resend secret values and Resend domain verification are intentionally not read or printed by this package.
