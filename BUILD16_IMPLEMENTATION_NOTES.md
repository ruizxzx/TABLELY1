# TABLELY Build 16 — Implementation Notes

Build 16 is layered on TABLELY Build 15 V4.

Implemented:
- Category -> Subcategory -> Menu Item hierarchy.
- Meal section, Featured, Popular and availability fields.
- Variants with server-controlled price deltas and one-default enforcement.
- Modifier groups with required/optional, single/multi-select, min/max rules.
- Modifiers with availability and price deltas.
- Legacy Build 5-15 add-ons remain readable/accepted for existing carts while new UI uses the modifier engine.
- Dietary/allergen metadata using the requested vocabulary and extensible additional allergen codes.
- Translation storage for categories, subcategories, items, variants, modifier groups and modifiers; customer UI supports English, Bengali and Hindi with fallback.
- Immutable order-item configuration snapshots.
- Server-side variant/modifier availability, selection-rule and price validation.
- Menu-item quota guard; variants/modifiers/translations/tags/categories do not consume menu-item quota.
- Public menu feed expanded with hierarchy, attributes, translations and configurable options.
- Customer product -> variant -> modifier -> cart flow.
- Kitchen, restaurant Orders and customer order tracking show configured item snapshots.
- Existing PAY_NOW/PAY_AT_COUNTER flow, Build 14 charges, Build 15 Kitchen acceptance and realtime behavior retained.
- Branch-scoped RLS for all new tables and permission-gated writes.

Validation performed in the sandbox:
- ZIP extraction and archive integrity.
- TypeScript/TSX syntax transpilation for every edited application file.
- JSON package validation.
- SQL migration structural checks: one top-level BEGIN/COMMIT, balanced PostgreSQL dollar-quoted function bodies, no reference to the known insecure cancellation overload, required Build 14 payment safeguards preserved in the source base, and required Build 16 fields/functions present.

Not possible in this environment:
- Live execution of the SQL against the user's Supabase project.
- Full `npm install`, `npm run typecheck`, `npm run lint`, or `npm run build` because package installation could not complete without registry access.

Run the new migration only after the existing Build 15 V4 migrations and in a staging/backup environment first.
