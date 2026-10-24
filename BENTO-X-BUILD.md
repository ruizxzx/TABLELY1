# INSATLY Bento X — Unified Page Builder

## What changed

- Unified the legacy Link Hub sections and new Bento widgets into a single spatial document.
- Profile, socials, featured work, projects, store, newsletter, contact, saved links and branding are native Bento system nodes.
- One responsive geometry engine is used for editor composition and the public renderer.
- Continuous four-corner resizing uses real grid position/span data rather than only legacy 1x1/2x1/1x2/2x2/full presets.
- Collision-aware placement and reflow keep the active block anchored while resolving overlaps.
- Dragging provides live placement feedback; final pointer position is committed synchronously so the last frame is not lost.
- Desktop, tablet and mobile geometry are stored independently. New system nodes receive intentional mobile/tablet compositions, while existing manual geometry is preserved.
- Editor zoom is accounted for during pointer-to-grid calculations, and editor row height follows the active device so resize behavior remains aligned with the rendered grid.
- Preview mode uses the same Bento block renderer as the public page and applies the page typography/motion/texture context.
- Editor controls include content, layout, style, animation, responsive and advanced panels; layers, locks, visibility, smart arrange, templates, undo/redo and keyboard movement are included.
- Image blocks support upload through the existing store-media storage path, destination linking, crop/focal-point positioning and object-fit controls.
- Legacy theme/background/accent controls are synchronized with the Bento page design so existing controls continue to affect the new renderer.
- Existing links accept the legacy full HTTPS destinations plus safe mail/tel/SMS/WhatsApp and relative/hash destinations; media inputs remain HTTPS-only.
- Public Link Hub uses one Bento canvas instead of separate auxiliary section grids.

## Backward compatibility

Existing Bento blocks are normalized from legacy `size` + `position` data into responsive geometry automatically. Existing system-node styling, visibility, locks and manually saved responsive geometry are preserved where present. No Supabase schema migration is required; the new layout/design metadata remains inside the existing Link Hub configuration.

## Validation completed in the build environment

- TypeScript/TSX syntax/transpile validation: **162 app files, 0 parse diagnostics**.
- Relative import existence scan: **0 missing relative imports**.
- CSS brace-balance check: **balanced**.
- Pure TypeScript compile of the dependency-free Bento layout modules: **passed**.
- 80-widget collision/reflow tests across desktop/tablet/mobile: **passed**.
- Unified system-node responsive layout tests: **passed**.
- Legacy custom/system style persistence and disabled-state compatibility tests: **passed**.

## Environment limitation

The repository's npm dependencies were not available in the execution environment. `npm ci --offline` stopped because required packages were not cached, and `npm run build` could not start because `next` was therefore unavailable. The delivery ZIP excludes `node_modules` and the local `.env.local` file. Run `npm ci` followed by `npm run build` in a normal network-enabled development/CI environment before deployment.
