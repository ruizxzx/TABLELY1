# TABLELY — CURRENT STATE & BUILD-CONTEXT MASTER DOCUMENT

**Document purpose:** This file is the master context for future AI-assisted development of TABLELY.  
Use it as the baseline before proposing, coding, migrating, refactoring, or extending any future build.

---

## 0. MASTER RULE — PRESERVE THE EXISTING PRODUCT

TABLELY is being built incrementally in numbered builds.

### Non-negotiable rule

> **Do NOT redesign, rewrite, clean up, simplify, or replace previously working functionality unless the user explicitly requests it or the current issue demonstrably requires touching that area.**

Previously confirmed Claude fixes are **frozen / regression-sensitive**.

A future build must be treated as an extension of the current system, not as a fresh implementation.

### Before making changes

1. Inspect the current codebase.
2. Identify the existing implementation of the feature being changed.
3. Preserve existing behavior unless the new requirement explicitly changes it.
4. Check database functions, SQL migrations, UI flows, and client state together where relevant.
5. Avoid stale assumptions from old build documents when the live database or current code contradicts them.
6. Never introduce a second competing implementation of an existing workflow merely because it is cleaner or newer.

### Build discipline

- Every new build must have a clearly defined scope.
- Do not silently include unrelated refactors.
- Do not remove existing features because they are not part of the new build.
- Do not change payment, session, RLS, pricing, checkout, or order semantics while implementing an unrelated feature.
- New migrations must be safe, explicit, idempotent where appropriate, and fail loudly on unexpected state.
- Do not create stale overloaded SQL functions.
- Do not assume a migration is applied merely because the file exists.
- Verify the live DB after DB changes.

---

# 1. PROJECT IDENTITY

**Product:** TABLELY

**Core concept:** QR-based restaurant table ordering and table/session operations platform.

Customers scan a table QR code, access the restaurant menu, create a cart, submit orders, optionally pay online or at the counter, and interact with the restaurant through the system.

Restaurant staff/managers operate through the dashboard.

---

# 2. CURRENT DEVELOPMENT BASELINE

### Completed

- **BUILD 1–14:** Complete
- **BUILD 15:** Complete
- **BUILD 16:** Complete
- **BUILD 17:** Tables + Orders, extended/fixed through subsequent work
- **BUILD 18:** Coupon/order/payment-related fixes and hotfixes
- **BUILD 19.1–19.4:** Session lifecycle, order-origin/pre-order support, coupon control-flow fix, stale SQL overload cleanup
- **BUILD 20 / 20.1:** Architecture reconciliation and customer browser cart/coupon isolation

### Current principle

The project is **not starting from Build 1 again**.

All future work starts from the current live architecture and must preserve the completed functionality above.

---

# 3. CURRENT AUTHORITATIVE STATE

The **live Supabase database is authoritative** for current database behavior.

Supabase project ref:

`zqgjpcjqmblqhqkhfdwc`

Do not trust an old migration description, stale package comment, or old architecture document over the current live database.

When there is a discrepancy:

```text
Current live DB / current code
        ↓
        is authoritative
        ↓
old package notes / old assumptions
```

---

# 4. IMPORTANT CURRENT SESSION ARCHITECTURE

TABLELY currently supports **multiple open sessions on the same physical table**.

There is intentionally **NO ACTIVE-PER-TABLE UNIQUE CONSTRAINT**.

This is important and must not be reintroduced.

### Current relevant table/session indexes

Known current indexes include:

- `table_sessions_open_visit_token_uidx`
  - unique on `session_token_hash` for open sessions (`ACTIVE` / `SETTLING`)
- `table_sessions_table_open_idx`
- `table_sessions_table_status_idx`

The old model of "one active session per physical table" is not the current model.

---

# 5. SESSION IDENTITY MODEL

A physical table is **not** the session identity.

A customer visit/session is resolved using the visit/session token.

Relevant session-resolution functions include:

- `build19_resolve_session_for_write`
- `build19_resolve_session_by_hash`

### Device token

The device token is supporting metadata.

It is **not the primary identity of the restaurant visit/session**.

Do not redesign session identity around:

- table code alone
- customer phone number alone
- customer name
- browser device alone

The same physical table can legitimately have multiple sessions.

The same customer phone number can also appear across different visits/sessions.

---

# 6. TABLE + SESSION MODEL

The current architecture allows:

```text
PHYSICAL TABLE
│
├── SESSION A
│    ├── Order A1
│    └── Order A2
│
├── SESSION B
│    ├── Order B1
│    └── Order B2
│
└── SESSION C
     └── Order C1
```

This is intentional.

### Why

A restaurant table can have:

- multiple independent customer visits over time
- overlapping visits in the current data model
- multiple customers ordering from the same physical table
- unpaid/unfinished orders that must not be accidentally closed

Therefore:

> **Never assume one physical table = one open session.**

---

# 7. ORDER ATTACHMENT

Current behavior:

- Repeated orders from the same visit/session remain attached to that session.
- A genuinely different visit can receive a different session on the same physical table.
- `build17_attach_order_session` preserves an explicit session ID where one is supplied.

This must remain intact.

### Example

```text
Customer A
QR → Session A → Order #1 → Order #2

Customer B
new independent visit
QR → Session B → Order #3
```

Order #3 must not silently join Session A simply because the physical table is the same.

---

# 8. ORDER CREATION + PAYMENT ARCHITECTURE

## PAY_AT_COUNTER

Current `create_order_for_table_v18` is the active order-creation path.

Current live signature is the **10-parameter** version.

PAY_AT_COUNTER orders attach to the resolved session.

## PAY_NOW

Current `create_payment_attempt_for_table_v18` is the payment-first path.

Current live version is the **9-parameter** version.

Important behavior:

> PAY_NOW does **not** create the final restaurant order simply because the customer starts payment.

The restaurant order is created/finalized through the successful payment flow.

This distinction exists specifically to prevent unpaid/failed payment attempts from appearing as normal restaurant orders.

Relevant function:

- `finalize_payment_attempt_v18`

### Do not regress this

Never restore the old behavior where clicking "Pay Now" instantly creates the restaurant order before successful payment unless the user explicitly requests that product behavior.

---

# 9. PAYMENT SAFETY RULES

Previously encountered payment/order errors showed why payment state and order state must remain distinct.

Important existing semantics:

### PAY_NOW

An online order must be settled through the online payment flow.

### PAY_AT_COUNTER

A completed/paid order must not be marked paid again.

Do not bypass these safeguards just to make a button "work".

Any payment-related build must preserve:

- payment attempt state
- payment finalization
- idempotency
- order/payment reconciliation
- correct payment method
- no double settlement
- no creation of false paid orders

---

# 10. CHECKOUT IDEMPOTENCY

Existing checkout idempotency must remain unchanged unless explicitly changed by the user.

Current storage key:

```text
tablely-checkout:{tableCode}
```

It remains in `sessionStorage`.

Do not replace or duplicate this mechanism while changing customer cart behavior.

---

# 11. BUILD 18 COUPON HOTFIX HISTORY

There was an edited manual hotfix:

```text
202609170016_build18_coupon_unassigned_record_fix.sql
```

This fixed the PAY_AT_COUNTER path where `v_coupon` could be unassigned.

### IMPORTANT TIMESTAMP COLLISION

There are two different files beginning with `202609170016`.

Do not confuse them:

```text
202609170016_build18_coupon_unassigned_record_fix.sql
```

and

```text
202609170016_build19_1_session_on_first_order.sql
```

They are different migrations with different purposes.

The Build 18 coupon hotfix was the last manual hotfix before the Build 19.1–19.4 migration chain.

---

# 12. BUILD 19.1–19.4 — CURRENT MIGRATION CHAIN

These migrations were run in this order:

### 1

```text
202609170016_build19_1_session_on_first_order.sql
```

### 2

```text
202609170017_build19_2_origin_and_preorder_requests.sql
```

### 3

```text
202609170018_build19_3_coupon_control_flow_fix.sql
```

### 4

```text
202609170019_build19_4_drop_stale_overloads.sql
```

This chain is the current Build 19 database baseline.

---

# 13. BUILD 19.3 COUPON CONTROL-FLOW FIX

The actual executable PAY_NOW function was corrected so that:

- `v_coupon` is only read inside the coupon-code branch.
- Coupon fields are copied into typed scalar variables:
  - `v_coupon_id`
  - `v_coupon_code`
  - `v_coupon_discount_type`
  - `v_coupon_discount_value`
- Downstream inserts use the safe scalar values rather than unsafe `v_coupon.*` references outside the valid control-flow scope.

There was an earlier review confusion caused by a code-looking example in the migration's comments/header. That text was **commentary only**, not executable SQL.

Future AI systems must distinguish:

```text
SQL comments/documentation
```

from:

```text
actual executable function body
```

before reporting a bug.

---

# 14. BUILD 19.4 — STALE FUNCTION OVERLOAD CLEANUP

Migration:

```text
202609170019_build19_4_drop_stale_overloads.sql
```

The purpose is to:

- drop stale legacy function signatures
- preserve/reassert the intended current function
- prevent multiple public overloads with conflicting behavior
- fail loudly if unexpected duplicate public signatures remain

There was also a standalone hotfix equivalent to this cleanup.

### IMPORTANT

Do not run the standalone hotfix **in addition to** the same cleanup migration unless explicitly required.

The migration and standalone cleanup were alternative ways to perform the same stale-overload cleanup.

---

# 15. PRE-ORDER / ORDER ORIGIN SUPPORT

Build 19 introduced order-origin/session lifecycle support.

Relevant concepts include:

- order origin
- customer order
- pre-order/request before the first order
- session creation on the first real order where appropriate
- service/request awareness

Do not remove the distinction between:

- an actual restaurant order
- a customer session/visit
- a pre-order or service request

These are separate concepts.

---

# 16. SESSION LIFECYCLE — CURRENT VS PLANNED

This distinction is extremely important.

## CURRENTLY SUPPORTED

The live architecture supports multiple concurrent open sessions on the same physical table.

A paid previous session can remain open.

A newer session can start concurrently.

This is why the current UI can legitimately show:

```text
Table 01
├── Session A → previous customer
└── Session B → new customer
```

## PLANNED / AGREED SESSION-LIFECYCLE BEHAVIOR

The agreed target behavior is a **hybrid automatic + manual lifecycle**.

### Rule

> If a genuinely new independent customer visit starts, an older session may be automatically closed only when that older session is completely settled and has no remaining blocking work.

Otherwise it stays open.

### Auto-close condition

Conceptually:

```text
all orders financially settled
AND
no active/unfinished orders
AND
no payment pending/in progress
AND
no blocking unresolved session work
```

Then:

```text
YES → safe to auto-close
NO  → keep open
```

### Manual fallback

Managers should retain:

```text
Close Session
```

for abandoned/stuck/exception cases.

### DO NOT implement this as:

```text
new session detected
        ↓
blindly close previous session
```

That is unsafe.

---

# 17. SHARED TABLES / CONCURRENT SESSIONS

The current multiple-session architecture is compatible with shared-table scenarios.

However, a critical distinction must be preserved:

> **"A new session exists" is not automatically the same as "the previous customer has left."**

For example:

```text
TABLE 01
│
├── Session A → Person 1 → unpaid → OPEN
├── Session B → Person 2 → paid
├── Session C → Person 3 → unpaid → OPEN
└── Session D → Person 4 → paid
```

These sessions can coexist.

### Therefore

Automatic closure must not blindly close an earlier session merely because another session was created.

Future shared-table/session work must distinguish:

- a genuinely new independent visit
- another customer sharing an existing table visit
- an older customer who has finished
- an older session with unresolved payment/work

This distinction is a core architecture rule.

---

# 18. TABLE OCCUPANCY VS SESSION STATUS

These are separate concepts.

A session can close while another session on the same physical table remains open.

Therefore:

```text
Session A → CLOSED
Session B → OPEN
```

does **not** mean:

```text
Table → AVAILABLE
```

The table should remain occupied while an active/open session still exists.

Conceptually:

```text
IF any active/open session exists
    → table remains occupied

IF no active/open sessions exist
    → table may become available
```

Current table operational synchronization is designed for multiple sessions.

Relevant function:

```text
build17_sync_table_operational_state
```

This logic must not be replaced by simplistic "one session per table" logic.

---

# 19. CLOSE SESSION BEHAVIOR

Relevant function:

```text
close_table_session
```

Current behavior closes the **specified session**.

It does not mean "close every session on the physical table."

This is required for concurrent sessions.

Do not rewrite it into a table-wide close operation.

Existing close safeguards are meaningful and should remain protective against closing a session that still has unresolved work.

---

# 20. BUILD 20 / CUSTOMER BROWSER ISOLATION

Build 20.1 addressed a different problem:

### Problem

Old browser state keys were table-wide:

```text
tablely:cart:{tableCode}
tablely:coupon:{tableCode}
```

That can cause separate browser contexts/customers using the same physical table to share browser cart/coupon state.

### New design

Customer browser state is scoped to:

```text
tablely:cart:{tableCode}:{visitContextId}
tablely:coupon:{tableCode}:{visitContextId}
```

### Context identity

The browser visit context is generated per browser tab/visit context.

Implementation uses `window.name` with a prefix similar to:

```text
tablely:tab:
```

This context ID:

- survives same-tab navigation
- survives reload
- is independent per normal browser tab
- is not derived from the table code
- is not derived from the server session
- is not derived from customer phone/name

### Why `window.name`

`window.name` was intentionally used instead of relying on `sessionStorage` as the identity mechanism, because opener/clone behavior can cause sessionStorage state to be copied into a new tab in some browser flows.

---

# 21. BUILD 20.1 STORAGE RULES

Current browser-state keys:

```text
cart:
tablely:cart:{tableCode}:{visitContextId}

coupon:
tablely:coupon:{tableCode}:{visitContextId}
```

### Old keys

The old table-wide keys are **not migrated** into the new per-context keys.

This prevents accidental leakage of old shared cart/coupon state.

### Checkout idempotency

Still remains:

```text
tablely-checkout:{tableCode}
```

in `sessionStorage`.

Do not confuse checkout idempotency with cart/coupon isolation.

They solve different problems.

---

# 22. BUILD 20.1 CUSTOMER STATE IMPLEMENTATION

Relevant behavior:

```ts
getCustomerVisitContextId()
```

returns the browser visit context.

Cart helper:

```ts
cartStorageKey(tableCode)
```

builds:

```text
tablely:cart:{tableCode}:{contextId}
```

Coupon helper:

```ts
couponStorageKey(tableCode)
```

builds:

```text
tablely:coupon:{tableCode}:{contextId}
```

Read/save/clear operations use these scoped keys.

Storage listeners filter using the current cart/coupon keys.

Custom events remain same-document events and are not assumed to be a cross-tab synchronization mechanism.

---

# 23. CURRENT VERIFIED CUSTOMER/SESSION SCENARIO

A real test on Table 01 demonstrated the intended separation.

The table showed two active sessions.

One earlier session contained already completed/paid orders.

A new incognito visit created a new session and placed an order under that new session.

Observed structure:

```text
Table 01
│
├── Session A
│   ├── previous customer
│   └── previous paid/completed orders
│
└── Session B
    ├── new customer
    └── new order
```

This is correct and must be preserved.

The fact that the same phone number can appear on separate sessions does not make the sessions the same visit.

---

# 24. CURRENT TABLE UI INTERPRETATION

The Tables dashboard may legitimately show:

```text
Table 01
3 active orders
2 open sessions
```

while one session contains paid/completed historical orders and the other contains current work.

That is not automatically a bug.

A session's total can include its orders even when some are already paid/completed.

The number of open sessions and number of active orders are different metrics.

Future AI work must not "fix" this by forcing one session per table.

---

# 25. TESTING REQUIREMENTS

Future builds must be tested at multiple layers.

## A. Basic application sanity

- Tables page loads
- Orders page loads
- Bills page loads
- No runtime TypeErrors
- No console errors caused by the build

## B. Session creation

- Scanning QR alone must not create an incorrect duplicate session.
- First legitimate order should resolve/create the proper session.
- Existing visit must keep using its session.

## C. Multiple sessions

Test:

```text
Browser A → Table 01 → Session A → Order A
Browser B/incognito → Table 01 → Session B → Order B
```

Verify orders remain attached to the correct sessions.

## D. Repeated ordering

Within one browser visit:

```text
Order 1
Order 2
Order 3
```

All should remain correctly attached to that visit/session.

## E. Shared-table concurrency

Test several customers using the same table concurrently.

Do not assume the newest session invalidates older sessions.

## F. Payment

Test:

- PAY_AT_COUNTER
- PAY_NOW
- successful online payment
- failed online payment
- abandoned payment
- payment retry
- double submit
- repeated payment attempts
- completed order cannot be paid twice

## G. Coupon

Test:

- no coupon
- valid coupon
- invalid coupon
- coupon on PAY_AT_COUNTER
- coupon on PAY_NOW
- coupon clearing
- multiple browser contexts using different coupons

## H. Browser isolation

At minimum:

1. Same tab navigation
2. Same table, two tabs
3. Tab A checkout must not clear Tab B cart
4. Different tables in same browser
5. Coupon isolation
6. Reload persistence
7. New tab isolation
8. Checkout retry/double-submit behavior

---

# 26. SQL / DATABASE SAFETY RULES

Never assume a migration ran successfully.

For every DB migration:

```text
1. Run migration.
2. Check errors.
3. Inspect resulting function signatures.
4. Inspect constraints/indexes when relevant.
5. Test the affected RPC/function.
6. Confirm old/stale overloads are absent.
```

### Especially important

Avoid creating multiple public overloads of a critical RPC with different parameter signatures unless that is explicitly intended.

A future migration should not leave behind stale implementations that can be accidentally selected by the client.

---

# 27. IMPORTANT KNOWN FUNCTION / PROCEDURE MAP

### Session resolution

```text
build19_resolve_session_for_write
build19_resolve_session_by_hash
```

### Order/session attachment

```text
build17_attach_order_session
```

### Table state

```text
build17_sync_table_operational_state
```

### Session close

```text
close_table_session
```

### PAY_AT_COUNTER / order creation

```text
create_order_for_table_v18
```

Current live signature: 10 parameters.

### PAY_NOW / payment attempt

```text
create_payment_attempt_for_table_v18
```

Current live version: 9 parameters.

### Online payment finalization

```text
finalize_payment_attempt_v18
```

Future AI should inspect these functions before replacing or duplicating behavior.

---

# 28. DO NOT REINTRODUCE THESE OLD/DANGEROUS ASSUMPTIONS

### ❌ One physical table = one active session

The current architecture intentionally supports multiple sessions.

### ❌ New session = old session must close

Not safe.

### ❌ Payment clicked = PAY_NOW order exists

Not current behavior.

### ❌ Customer phone = session identity

Not correct.

### ❌ Device token = session identity

Not correct.

### ❌ Table code = session identity

Not correct.

### ❌ Table-wide browser cart = safe

Not safe for multiple customers/contexts.

### ❌ `payment_status = PAID` alone means session can always close

Not sufficient.

### ❌ A closed session makes the physical table available

Only true if no other open/active session remains.

### ❌ Re-run equivalent hotfix and migration together

Can create redundant/conflicting work.

---

# 29. CURRENT SESSION-CLOSURE TARGET

The desired future lifecycle is:

```text
                NEW INDEPENDENT VISIT
                         │
                         ▼
             inspect older sessions
                         │
             ┌───────────┴───────────┐
             │                       │
       Older session fully      Older session
          settled?              unresolved?
             │                       │
            YES                      YES
             │                       │
        AUTO-CLOSE               KEEP OPEN
             │                       │
             └───────────┬───────────┘
                         ▼
                sessions may coexist
```

### Fully settled means conceptually

```text
all orders financially settled
+
no active/unfinished orders
+
no pending/in-progress payment
+
no blocking unresolved session work
```

Manager manual close remains available as the fallback.

---

# 30. WHAT IS IMPLEMENTED VS WHAT IS A DESIGN DECISION

This section is intentionally explicit so future AI does not claim a planned behavior is already implemented.

## Implemented / current

- Multiple sessions per physical table
- Session-aware order attachment
- Session-token-based resolution
- PAY_AT_COUNTER session attachment
- PAY_NOW payment-first flow
- Online payment finalization
- Stale overload cleanup
- Coupon control-flow fix
- Browser cart isolation by visit context
- Browser coupon isolation by visit context
- Checkout idempotency preserved
- Multiple sessions can coexist
- Table state aggregates multiple sessions

## Agreed target / not to be assumed already implemented

- Automatic closure of an older fully-settled session when a genuinely new independent visit begins
- Explicit shared-table semantics distinguishing "new independent visit" from "another customer sharing the same table"
- Any future Pay Later behavior unless separately implemented

Never report these planned items as already deployed without inspecting the current code/database.

---

# 31. FUTURE BUILD INSTRUCTIONS

For every future build, AI should produce work in this order:

### Step 1 — Understand

Read this document fully.

### Step 2 — Inspect

Inspect:

- current codebase
- current relevant components
- current SQL functions
- current migrations
- current database state when DB work is involved

### Step 3 — Map dependencies

Before modifying anything, identify whether the requested feature touches:

```text
UI
↓
client state
↓
session
↓
order
↓
payment
↓
database RPC
↓
RLS
```

Do not modify lower layers unnecessarily.

### Step 4 — Implement only the requested scope

Avoid opportunistic refactoring.

### Step 5 — Regression test

Test the new behavior plus all directly affected existing behavior.

### Step 6 — Verify database state

For migrations, verify signatures, constraints, indexes, and affected records/functions.

### Step 7 — Report exact changes

Future build reports should clearly distinguish:

```text
ADDED
CHANGED
PRESERVED
NOT TOUCHED
TESTED
KNOWN LIMITATIONS
```

---

# 32. REGRESSION-SENSITIVE AREAS

Treat these as high-risk areas:

1. Session resolution
2. Multiple sessions per table
3. Order-to-session attachment
4. PAY_NOW payment-first flow
5. PAY_AT_COUNTER settlement rules
6. Coupon calculation/control flow
7. SQL RPC overloads/signatures
8. Checkout idempotency
9. Browser cart isolation
10. Browser coupon isolation
11. Table operational-state synchronization
12. Session close safeguards
13. RLS/security boundaries
14. Pricing/totals/tax/discount calculations

Any build touching one of these areas must explicitly regression-test it.

---

# 33. CONTEXT FOR THE CURRENT NEXT BUILD

The immediate architectural direction after the current Build 20 reconciliation is:

### Preserve

```text
multiple sessions per table
+
correct session-token identity
+
payment/order separation
+
browser visit-context isolation
+
existing payment and coupon safeguards
```

### Potential next extension

Implement the agreed **hybrid session lifecycle** carefully:

```text
new genuinely independent visit
        ↓
older session fully settled?
        ↓
YES → auto-close older session
NO  → keep older session open
```

But before implementing automatic closure, the system must define/verify how TABLELY distinguishes:

```text
NEW INDEPENDENT VISIT
```

from:

```text
CUSTOMER JOINING/SHARING EXISTING TABLE
```

This is essential because blindly treating every new session as a reason to close the previous session would conflict with concurrent/shared-table behavior.

---

# 34. MASTER AI PROMPT

Use the following block as the operational instruction for a future AI coding agent:

> You are extending an existing production-oriented TABLELY codebase.
>
> Treat this document as the architectural baseline.
>
> Do not restart, redesign, rewrite, or clean up working features.
>
> Preserve all completed Builds 1–20 behavior unless the requested change explicitly modifies it.
>
> Treat confirmed previous fixes as frozen/regression-sensitive.
>
> Inspect the current code and live DB before changing behavior.
>
> The live DB is authoritative for database state.
>
> TABLELY intentionally allows multiple sessions on the same physical table. Do not reintroduce a one-active-session-per-table constraint.
>
> A table is not a session. A phone number is not a session. A device token is not the session identity. Session identity is resolved through the existing session/visit-token architecture.
>
> Preserve PAY_AT_COUNTER order creation semantics and PAY_NOW payment-first semantics.
>
> PAY_NOW must not create the final restaurant order merely when payment starts.
>
> Preserve payment settlement safeguards and checkout idempotency.
>
> Preserve browser cart/coupon isolation by visit context:
>
> `tablely:cart:{tableCode}:{visitContextId}`
>
> `tablely:coupon:{tableCode}:{visitContextId}`
>
> Preserve checkout idempotency:
>
> `tablely-checkout:{tableCode}`
>
> Do not introduce unrelated migrations, refactors, or changes.
>
> Never assume a migration ran just because a file exists.
>
> Verify SQL functions, signatures, indexes, constraints, and affected runtime behavior after DB changes.
>
> Do not blindly close an old session because a new session exists.
>
> The agreed session lifecycle is hybrid:
>
> - fully settled old session + genuinely new independent visit → old session may auto-close
> - unpaid/active/unresolved old session → keep it open
> - manager manual close remains available
>
> Shared-table/concurrent-session behavior must remain supported.
>
> Every implementation must include regression testing for all affected existing functionality.
>
> When finished, report exactly what was changed, what was preserved, what was tested, and any remaining limitation.
