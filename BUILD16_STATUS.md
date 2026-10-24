# TABLELY Build 16 — Menu 2.0

Implemented on top of Build 15 V4.

Includes: category/subcategory hierarchy, meal sections, featured/popular flags, variants, modifier groups and modifiers with selection rules, dietary/allergen metadata, translation storage and UI, server-side configuration pricing/validation, immutable order configuration snapshots, menu-item quota guard, public menu expansion, cart configuration support, branch-scoped RLS, and Build 15 Kitchen compatibility.

Validation performed: archive integrity, static TypeScript syntax/bracket checks, SQL structural checks, migration dependency review, and diff review. Live Supabase execution and a production Next build were not available in the sandbox; run the SQL in staging first and then `npm run typecheck && npm run lint && npm run build`.
