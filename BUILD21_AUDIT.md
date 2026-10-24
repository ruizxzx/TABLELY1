# Build 21 Production-Hardening Audit

Date: 2026-09-23
Baseline: supplied `instaly-main(1).zip`

## Classification

### Already complete on the supplied baseline

- Build 20 primary-public-page URL toggle and canonical Bento document architecture.
- Shared `BentoPublicRenderer` / `BentoBlockView` public composition.
- Isolated `/bento-preview` route with `noindex` metadata and `showBeacon={false}`.
- Reduced-motion and mobile-safe interaction behavior already present.
- Existing Build 20 source-regression contracts and Build 19/Bento regression suites.
- Existing plan/branding model: Free retains INSTALY branding; Creator/Pro/Max hide it; Pro/Max support custom domains.

### Build 21 hardening implemented

- Centralized public route helpers and preserved-query handling.
- Canonical `/username`, `/links/username`, `/store/username` behavior aligned with `primaryPage`.
- Legacy root product/bundle/checkout paths now redirect to canonical `/store/...` routes.
- Legacy `/r/...` and `@username` public aliases redirect without maintaining competing renderers.
- Product, bundle, checkout, dashboard, share, and email URL generation uses canonical helpers where applicable.
- Explicit public aliases reuse the same rendering implementation; metadata is propagated to explicit routes.
- Bundle metadata now has canonical Open Graph/URL metadata; checkout surfaces are no-index.
- Canonical analytics identity migrated to `instaly_visitor_id` / `instaly_session_id` with one-time compatibility read of legacy keys.
- Analytics events receive event IDs and DB-level uniqueness protection.
- Analytics endpoint filters obvious automated traffic and validates stores/products/links.
- Preview/editor beacon exclusion remains intact.
- Purchase analytics now follows the paid-order population, with idempotent purchase event insertion.
- Attribution is retained when reusing a pending payment order.
- Product-page views and both product/bundle checkout starts are emitted through the canonical analytics identity.
- UTM/referrer attribution is preserved across public aliases/redirects.
- Public content truncation is separated into explicit safety limits rather than the old 9/10/12/50-style display caps.
- Studio save handling no longer truncates legacy Link Hub links/projects at the old small limits.
- Public Bento grids no longer use nested `overflow:auto` scrolling.
- Pointer/drag physics use `requestAnimationFrame` batching to reduce render/DOM pressure.
- Repeated editor block lookup/findIndex work was reduced with a keyed lookup map and layout index reuse.
- Added visible focus treatment and reduced-motion scrolling safeguards.
- Added accessible labels to editor icon-only layer controls and public menu behavior.
- Updated remaining customer-facing Sellora branding references to INSTALY where they were external/user-visible; internal schema identifiers remain intentionally unchanged.

## Regression checks run

- TypeScript/TSX syntax transpilation: 187 files checked, 0 syntax errors.
- `npm run test:bento`: PASS.
- `npm run test:bento19`: PASS.
- `npm run test:bento20`: PASS.
- Build 20 source regression script: PASS.

## Environment limitation

A clean dependency install was attempted with `npm ci --ignore-scripts --no-audit --no-fund`, but the installation exceeded the execution window and did not produce a complete `node_modules` tree. Consequently:

- `npm run lint`: NOT PASSABLE in this environment; TypeScript reports missing `estree`, `json-schema`, `node`, `react`, and `react-dom` type definitions.
- `npm run typecheck`: same dependency/type-definition limitation.
- `npm run build`: unavailable because the local `next` binary was not installed.

These checks are recorded as environment/dependency failures, not as successful test results.

## Intentional non-changes

- No rewrite of Build 1–20 architecture.
- No blind rename of `sellora_*` database/internal identifiers.
- No change to the established billing/entitlement model.
- No destructive removal of legacy URLs; compatibility aliases remain as redirects.
