TABLELY — Repository Instructions for AI Coding Agents
These instructions apply to all work in the TABLELY repository unless a deeper AGENTS.md file overrides them. The repository's actual source code, database schema, migrations, package scripts, and deployed configuration are the source of truth. Do not assume that a feature is implemented merely because it appears in a roadmap, build report, or previous conversation.
1. Product and engineering context
TABLELY is a multi-tenant restaurant operations and customer-engagement SaaS. Its product areas may include restaurant onboarding, branches, menus, QR ordering, customer visits, carts, checkout, payments, bills, kitchen operations, staff permissions, customer engagement, loyalty, WhatsApp, Google Business Profile, support messaging, analytics, AI-assisted menu import, and platform administration.

The known technology direction includes Next.js, React, TypeScript, Supabase/PostgreSQL, Supabase Auth and Realtime, Razorpay, Resend, and Vercel. Verify exact versions, libraries, folder paths, and installed capabilities from the current repository before relying on these assumptions.

Do not rebuild TABLELY as a new application. Extend the current architecture, use existing components and domain logic, and make the smallest safe change that fulfils the task.
2. Mandatory workflow before making changes
For every task:
1. Inspect the repository structure and read the relevant source files, package manifest, lockfile, database migrations, and project documentation.
2. Find the existing implementation before creating a new one. Search for related tables, RPCs, API routes, hooks, components, services, policies, and tests.
3. Trace the complete data flow: UI → API/server action → authorization → database/RPC → external provider or Realtime → UI update.
4. Identify affected workflows and invariants before editing.
5. Write a short implementation plan for complex changes, then implement the complete requested scope—not just a UI mockup.
6. Add or update tests for the behaviour changed, including negative and authorization cases.
7. Run the checks actually available in the repository. Report commands and their real results.
8. Review the final diff for accidental changes, secrets, debug code, incomplete TODOs, dead controls, and unrelated refactoring.
9. Update the relevant documentation and build history.
Do not ask the user to repeat information already present in the repository or conversation. If an external credential, database, provider account, or staging environment is unavailable, complete the locally verifiable work and clearly identify the remaining blocker.
3. Preservation rules — do not break existing behaviour
The following are core TABLELY business rules. Verify their exact implementation before changing them, and preserve them unless the task explicitly authorizes a change.
Restaurant and branch tenancy
- Every restaurant-owned record must be scoped to the correct restaurant/organization.
- Branch-scoped records and operations must enforce the caller's actual branch permissions.
- Never trust a restaurant_id, organization_id, branch_id, user_id, role, or ownership claim supplied by the browser without server-side validation.
- A user's membership in a restaurant does not automatically grant access to every branch or every financial/customer record.
- Platform administrators, restaurant owners, managers, and staff have different trust boundaries. Enforce permissions on the server and in database policies, not merely by hiding UI controls.
- Never expose one restaurant's records, credentials, customers, tickets, reports, messages, or attachments to another restaurant.
Customer visits, tables, and QR ordering
- A QR scan alone must not create a persistent occupied-table session unless the existing product rules explicitly say otherwise.
- A persistent table/order session should be created only through the valid existing ordering/session lifecycle.
- Multiple independent customers may use the same physical table. Do not model a table as having only one globally active customer identity.
- Do not use table_id alone as the identity for a cart, visit, conversation, or customer.
- Preserve visit-token isolation and the existing browser-tab identity design. Inspect the actual implementation (including storage and token lifecycle) before changing it.
- Customer A must never see Customer B's cart, messages, payment data, or private order history, even when both use the same table or device at different times.
- New QR redirect logic must remain backward-compatible with already printed QR codes and must not create a session merely by resolving a URL.
- A takeaway/pickup order must not occupy a dine-in table.
Orders and checkout
- The server is authoritative for menu prices, modifiers, quantities, discounts, taxes, service charges, totals, and eligibility.
- Never trust a client-supplied total, discount, tax, payment status, or final price.
- Reuse the existing checkout calculation engine. Do not create a parallel calculation path for loyalty, split bills, reordering, coupons, or new order modes.
- Preserve existing order-state transitions and use explicit, validated transitions.
- Retrying a request must not accidentally create duplicate orders, payments, inventory deductions, rewards, or notifications.
- A customer reordering a historical purchase must be charged current prices and use current availability, variants, modifiers, and coupon rules. Never reuse an old payment reference or historical price.
Payments and financial records
- Preserve the separation between restaurant food-order payments and TABLELY SaaS subscription billing.
- Preserve the existing restaurant-specific payment-provider credential model. Do not route one restaurant's payments through another restaurant's credentials.
- Keep provider secrets server-side and encrypted at rest using the repository's approved secret-storage approach.
- Never expose API keys, webhook secrets, service-role keys, OAuth refresh tokens, or decrypted provider credentials to frontend code, URLs, logs, error responses, or committed files.
- Never treat a browser success redirect as proof of payment.
- Verify provider signatures server-side using the required raw request body where applicable. Verify payment/order association, amount, currency, and captured/settled state as required by the provider and existing data model.
- Use integer minor units (for INR, paise) for financial arithmetic. Avoid floating-point settlement comparisons.
- Use database transactions, unique constraints, and idempotency for checkout, payment verification, webhooks, refunds, bill settlement, split allocations, and ledger writes.
- Handle duplicate, delayed, concurrent, and out-of-order provider events safely. A stale event must not downgrade a later valid financial state.
- A payment captured by a provider but not reflected in TABLELY must be recoverable/reconcilable; do not silently discard provider evidence.
- Never mark arbitrary orders as paid through a manual UI shortcut. Any correction must be authorized, traceable, and supported by verified evidence.
- Keep historical transaction and receipt records auditable. Correct mistakes with adjustment/reversal records rather than deleting or silently rewriting history.
- Distinguish provider payment capture from provider/bank settlement. Do not label funds as bank-settled without verified settlement data.
Customer communication and consent
- Distinguish transactional/service messages from promotional marketing.
- Record the relevant consent purpose, source, timestamp, and withdrawal state where required.
- Respect opt-outs and provider policies. Do not infer marketing consent from placing an order.
- Never send promotional messages after the relevant consent has been withdrawn.
- Messaging/notification failure must not block checkout, order creation, payment, or kitchen processing.
- Do not expose private customer contact details to staff who do not need them.
4. Database and migration rules
- Inspect the current schema and migration history before designing a migration.
- Reuse existing tables, enums, functions, indexes, and relationships where appropriate. Do not create duplicate ledgers, customer identities, permission systems, menu models, or notification systems.
- Every new migration must use a unique, valid version according to the repository's migration convention.
- Check for historical duplicate versions and malformed migration filenames before adding new files.
- Never blindly rename, reorder, edit, or delete a historical migration. It may already have been applied to a deployed database. Reconcile against the actual migration ledger when available.
- Prefer additive, backward-compatible migrations. Avoid destructive operations, data loss, and unnecessary enum changes.
- Add appropriate foreign keys, check constraints, unique constraints, indexes, grants, and RLS policies.
- Review both USING and WITH CHECK conditions for policies where relevant.
- Pay particular attention to security-definer functions: validate caller identity and tenant/branch access, use a safe search_path, and grant execution only to intended roles.
- Do not assume service-role queries are protected by RLS. Explicitly scope every service-role read/write by authorized tenant and branch context.
- Do not apply migrations to a production database unless the user explicitly authorizes it. Local or staging execution must be clearly distinguished from production.
- If live migration history is unavailable, report that compatibility is unverified; do not claim the migration has been safely reconciled.
5. Realtime messaging and support rules
When working on customer↔restaurant or restaurant↔TABLELY support messaging:
- Persist messages in PostgreSQL as the durable source of truth. A transient Realtime event is not proof that a message was saved.
- Use private, authorized Supabase Realtime channels for private conversations. Do not expose private conversation contents on public channels.
- Enforce conversation membership and tenant/branch access in backend operations, database policies, and Realtime channel authorization.
- Keep customer↔restaurant conversations separate from restaurant↔TABLELY support tickets. They may share UI primitives or a messaging service, but must not share authorization scopes or expose each other's data.
- Do not identify a customer conversation using a physical table ID alone. Use the valid visit/conversation identity and authorization model.
- Support pre-order enquiries without accidentally creating a persistent table session.
- Use stable message IDs and idempotency. Reconcile optimistic UI messages with the persisted record so messages do not appear twice.
- Implement connection states, reconnect with bounded backoff, rejoin authorized channels, and fetch missed messages using a stable cursor after reconnection. A WebSocket connection alone does not guarantee message delivery.
- Typing indicators and Presence should be ephemeral and throttled. Do not write every typing event to the durable message table.
- Read receipts must be scoped to the correct participant/read cursor. Opening one conversation must not mark unrelated conversations as read.
- Revalidate access when membership or authentication changes. Removed staff must not retain access through an old channel subscription.
- Private notes in platform support must never be visible to restaurant users. Customer messages must never appear in the platform support inbox.
- Support assignment, status, priority, escalation, resolution, reopening, and audit events must be authorized and traceable.
- Store private attachments in private storage buckets. Validate size, type, ownership, conversation membership, and download access server-side. Use short-lived signed URLs.
Real-time acceptance standard: a newly persisted message should appear to authorized connected participants without page refresh or polling. After a disconnect, the client must recover missed persisted messages without duplicates.
6. External integrations
Razorpay and other payment providers
- Use the existing provider adapter and credential architecture.
- Validate signatures and all transaction bindings server-side.
- Make webhook handlers idempotent and safe under concurrency.
- Do not perform real payments in automated tests.
WhatsApp Business Platform
- Use the official Meta WhatsApp Business Platform/Cloud API or an explicitly approved BSP integration.
- Do not use WhatsApp Web automation, browser scraping, unofficial session libraries, or personal-account automation.
- Respect template categories, approval status, service-window rules, opt-in, opt-out, and provider rate limits.
- Use each restaurant's own authorized account/credentials when the product design is bring-your-own-account.
- Verify webhook signatures and persist events before acknowledging successful processing where required.
- Handle duplicate and out-of-order message-status events safely.
- Clearly distinguish message accepted, sent, delivered, read, and failed states.
Google Business Profile and reviews
- Use official Google OAuth and Business Profile APIs only where the project has the required access and location permissions.
- Manual review-link/QR functionality must not pretend to be an API-connected profile.
- Never create, buy, fabricate, incentivize, gate, or selectively solicit positive reviews.
- Provide the same neutral review opportunity to eligible customers regardless of private feedback/rating.
- Do not claim a review-link click resulted in a published review unless that relationship is reliably established.
- Require explicit owner approval before publishing an AI-drafted review response.
AI providers
- Use the repository's centralized AI provider/router when available. Do not add a second hardcoded provider integration for a feature that should use the central service.
- AI provider keys are server-side secrets and must be encrypted or kept in an approved secrets service.
- Model IDs and capabilities must be configured, not assumed. Verify vision, structured-output, context, and tool capabilities for the selected model.
- Validate model output against a schema before using it to write menu or business data.
- AI-extracted menu data must remain a draft until an authorized person reviews and publishes it.
- Never invent menu prices, ingredients, dietary claims, business metrics, or customer details.
- External AI failure must not block ordinary ordering or restaurant operations.
- Record usage/cost estimates accurately and label estimates as estimates.
Email and background jobs
- Reuse existing Resend and job/queue infrastructure where present.
- Use bounded retries, idempotency, and dead-letter/error visibility.
- Email/WhatsApp delivery must not be confused with successful order/payment persistence.
7. Code quality and implementation standards
- Follow the existing project conventions and TypeScript strictness.
- Prefer small, focused, reviewable changes over broad rewrites.
- Keep business logic out of large UI components where the repository uses service/helper layers.
- Validate API inputs at the server boundary with the project's existing validation library or established pattern.
- Return consistent, safe error responses. Do not expose stack traces, raw SQL errors, credentials, or sensitive provider responses to users.
- Handle loading, empty, success, error, retry, and disabled states in user interfaces.
- Every visible control must perform its advertised action. Do not leave placeholder buttons, fake success messages, or nonfunctional settings.
- Use pagination and server-side aggregation for large histories, financial reports, messages, reviews, or analytics. Do not silently present capped samples as lifetime totals.
- Use database-side aggregation for financial totals where appropriate.
- Avoid unnecessary dependencies. If one is added, explain why and update the lockfile.
- Keep accessibility, responsive behaviour, and keyboard interaction consistent with existing UI standards.
- Do not change unrelated routes, schemas, or styling as part of a focused task.
8. Testing requirements
Choose test commands from the current package.json and lockfile; do not invent scripts. At minimum, run the relevant available checks:
- TypeScript typecheck.
- ESLint.
- Unit tests.
- Integration tests where infrastructure is available.
- Database migration validation.
- RLS/tenant-isolation tests.
- Production build.
- Browser/end-to-end tests for critical user journeys where configured.
Add tests for both the happy path and security/failure paths.

For changes involving payments, test duplicate events, concurrent requests, failed and delayed provider responses, amount/currency mismatches, and retries.

For changes involving sessions or messaging, test separate customers on the same table, multiple tabs, stale tokens, reconnect/catch-up, duplicate delivery, and cross-tenant access.

For changes involving rewards, test concurrent redemption, refunds, cancellations, expiry, and duplicate events.

For integrations, use provider mocks or sandbox credentials. Never run real charges, send real WhatsApp messages, publish real Google reviews, or contact real customers during automated tests unless the user explicitly authorizes that action.

Report every check with one of these statuses:
- PASS — command/test actually ran and passed.
- FAIL — command/test ran and failed.
- BLOCKED — could not run because a dependency, credential, service, or environment was unavailable.
- NOT RUN — not attempted.
Do not convert BLOCKED or NOT RUN into PASS. Syntax transpilation is not a substitute for a full TypeScript typecheck. Static review is not a substitute for integration testing. A successful local build is not proof of production correctness.
9. Environment and secrets
- Never commit .env, .env.local, production credentials, API keys, tokens, private certificates, or customer data.
- Keep .env.example limited to variable names and safe descriptions/placeholders.
- Use server-only environment variables for secrets; never prefix secrets with NEXT_PUBLIC_.
- Validate required environment variables at the appropriate server startup/runtime boundary.
- Do not print secret values during diagnostics.
- Do not copy user-provided secrets into reports, tests, fixtures, screenshots, or generated archives.
- If a credential is exposed in chat, logs, screenshots, or repository history, recommend revocation and rotation rather than reusing it.
10. Documentation and build records
For each completed build or sub-build:
- Update the authoritative project/build documentation.
- Document new routes, services, database objects, environment variables, permissions, and provider configuration.
- Document migration order and deployment steps.
- Record which functionality is implemented versus externally configured or not verified.
- Record known limitations and rollback considerations.
- Avoid contradictory duplicate build-status documents.
Do not mark an entire build complete merely because its UI exists. Completion requires functional backend wiring, authorization, database integrity, failure handling, and relevant tests.
11. ZIP delivery rules
When the user requests a ZIP:
1. Preserve the supplied original archive.
2. Work in a separate project directory.
3. Include the complete project source, not only changed files.
4. Include lockfiles, SQL migrations, tests, static assets, configuration templates, and documentation.
5. Exclude node_modules, .next, caches, local environment files, secrets, and unnecessary generated artifacts.
6. Inspect the archive contents and verify it can be opened.
7. Provide a truthful completion report with changed files, migrations, actual test results, known issues, and external deployment steps.
8. Never describe a build as bug-free or production-certified unless the necessary checks were genuinely completed in a representative staging environment.
12. Explicitly prohibited shortcuts
Never:
- Replace the existing application with a generic scaffold.
- Rebuild a working feature without first understanding it.
- Create a duplicate table or second source of truth without justification.
- Bypass RLS to make a feature work.
- Use frontend-only authorization for sensitive operations.
- Trust client-supplied financial values or payment status.
- Use table ID alone as customer identity.
- Use public Realtime channels for private conversations.
- Treat a successful API request as proof of downstream delivery or settlement.
- Silently ignore database/provider errors.
- Silently swallow webhook failures.
- Use polling as the primary transport for a feature explicitly required to be real-time.
- Apply production migrations, deploy, change DNS, rotate credentials, or perform real transactions without explicit user authorization.
- Claim unexecuted tests passed.
13. Priority when requirements conflict
Resolve conflicts in this order:
1. Security, privacy, and financial integrity.
2. Existing production data integrity and backward compatibility.
3. Existing customer/session/order business rules.
4. Explicit user requirements for the current task.
5. Existing architecture and code conventions.
6. UI preferences and implementation convenience.
If a requested feature conflicts with an existing invariant, do not silently break the invariant. Explain the conflict, implement the safest compatible behaviour, and document any decision that materially changes product behaviour.