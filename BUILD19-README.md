# INSTALY BUILD 19 — TRUE WYSIWYG + RESPONSIVE + COMPLETE BLOCKS

Build 19 upgrades the Build 18 Bento editor without introducing a second page model or renderer.

## Scope

- Global page presentation is edited through the Bento Page Inspector and persisted in `bentoDesign`.
- Node presentation is stored with the canonical Bento node in `config`.
- Underlying creator data remains live and is hydrated without replacing node presentation.
- Desktop/tablet/mobile geometry remains independent and uses the existing 12/8/4 grids.
- Editor, preview, and public rendering continue to use the shared Bento rendering system.
- Legacy Link Hub controls remain only where they edit underlying creator data or onboarding state.
- All current Bento block types remain supported; Store renders live products because the existing schema has no standalone `product` block type.

## Build 19 editor features

- Page inspector for all currently supported global Bento design settings.
- Full node inspector across content/layout/style/animation/responsive/advanced controls.
- Explicit responsive viewport editing and geometry copy scaled to the target grid.
- Mobile content-growth hardening without changing established desktop behavior.
- Shared visual CSS variables/classes applied only when explicitly configured, preserving older custom block styling.
- Collision-safe geometry editing and responsive duplication.
- Singleton system-node protection.

## Verification

Passed in this environment:

- `npm run test:bento19`
- `npm run test:bento`
- 176/176 TypeScript/TSX syntax sweep
- canonical document preservation tests
- responsive geometry preservation tests
- live-data hydration tests
- migration/starter tests
- ZIP integrity and secret/build-artifact checks

The full project `typecheck`, `lint`, and `build` could not complete because the available environment does not contain the project's complete dependency tree and cannot download missing packages from the npm registry. `next` is therefore unavailable for a genuine production build/browser verification.
