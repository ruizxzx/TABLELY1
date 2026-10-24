# INSTALY BUILD 18 — FOUNDATION, VALIDATION & EDITOR CORE

## Scope

Build 18 upgrades the existing P0 Bento baseline without introducing a second page model or renderer.

### Included
- Canonical Bento persistence/migration preserved from P0.
- Mobile touch scrolling with explicit touch drag/resize handles.
- Native text/image selection disabled only inside the editor canvas; form fields remain selectable.
- Explicit move, resize, drag-preview, drop-target, collision/snap feedback.
- Layers panel with selection, visibility, lock and reorder controls.
- Lock enforcement for node, position, size and style.
- Transactional undo/redo and coalesced text/style/layer changes.
- Safe duplicate behavior with unique IDs and responsive geometry preservation.
- Drag-to-add with insertion preview and responsive default placement.
- Existing nodes are not implicitly repacked during normal pointer interactions.
- Historical duplicate system nodes are contained to one enabled owner during migration.
- Existing custom layouts are not replaced by starter layouts.

## Verification performed in the supplied environment

PASS:
- TypeScript/TSX parser sweep: 181 files, 0 syntax errors.
- Focused Bento regression suite: PASS.
- Canonical responsive geometry preservation.
- System-node customization preservation.
- Legacy/partial migration behavior.
- Live underlying product hydration.
- Duplicate system-node containment.
- Collision-safe placement.
- Deterministic starter layout validation.

Environment-limited:
- `npm ci` could not complete because the package registry was unreachable/timed out.
- `npm run typecheck` and `npm run lint` could not run to completion because required type packages were unavailable locally after the failed install.
- `npm run build` could not run because the `next` executable was unavailable for the same reason.
- Browser verification could not be performed because a production/dev Next.js server could not be started without the dependencies.

Do not treat the environment-limited checks as evidence of a successful production build. Run the complete dependency install and production checks in the deployment environment before release.

## Regression command

```bash
npm run test:bento
```
