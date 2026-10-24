# INSTALY BUILD 20 — Design System + Effects + Onboarding

Build 20 upgrades the Build 19 canonical Bento editor without introducing a second page model.

## Implemented

- Shared canonical Bento page-design defaults and normalization.
- Global page design controls wired through the same design object used by editor and public renderer.
- Responsive content density with deterministic effective grid gap.
- Shared editor/public visual tokens and effect variables.
- Pointer-relative spotlight tracking in the public renderer and editor-local pointer positioning.
- Global magnetic interaction for supported public blocks with touch/pen/reduced-motion fallbacks.
- Cursor effect orb with desktop-only behavior and graceful mobile/reduced-motion fallback.
- Noise opacity now respects the global noise switch.
- Animation index/delay support while preserving existing per-block animation settings; global animation intensity now controls public transitions.
- Six starter templates: Creator, Developer, Musician, Artist, Educator, Business.
- Starter templates seed only genuinely empty onboarding pages.
- Existing pages keep their canonical block/design state and are never silently re-templated.
- Starter pages use deterministic custom blocks and the existing canonical system-node migration boundary.
- Existing profile image crop/upload and onboarding social/link workflows remain intact.
- Server-side page-design normalization now uses the shared Bento implementation instead of a duplicated sanitizer.
- Editor canvas page alignment follows the saved Bento page-alignment setting.
- Onboarding starter selection is restricted to genuinely empty pages by checking for legacy creator content as well as existing Bento blocks.

## Backward-safety rules

- No database schema change.
- No deletion of legacy data.
- No automatic re-templating of existing pages.
- No replacement renderer.
- No editor-only page model.
- Existing responsive geometry is preserved.
- Unknown future design properties remain preserved by normalization.

## Verification

Passed in the supplied environment:

- `npm run test:bento20`
- `npm run test:bento19`
- `npm run test:bento`
- Build 20 source-invariant checks
- 177-file TypeScript/TSX parser sweep
- CSS brace/Build20-section integrity checks
- ZIP/artifact and secret scans

The full application `typecheck`, `lint`, `build`, and browser verification could not complete because the project dependency tree could not be installed in the supplied environment; the npm registry package cache was incomplete.
