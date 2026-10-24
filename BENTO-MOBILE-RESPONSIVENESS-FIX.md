# INSATLY Bento — Mobile Responsiveness Hardening

This build fixes the public Bento page so responsive geometry is used consistently at mobile/tablet widths without clipping content inside fixed-height cards.

## Changes
- Public Bento canvas keeps the same stored desktop/tablet/mobile geometry variables.
- Mobile uses the stored 4-column layout; tablet uses the stored 8-column layout.
- Public grid rows use `minmax()` so content-bearing cards can grow naturally when their contents require additional height.
- Product/project grids no longer create an internal scroll area that can hide additional items on mobile.
- Text-bearing cards use narrow-width-safe wrapping (`overflow-wrap`, `word-break`, `hyphens`) to prevent clipped titles and URLs.
- Editor Preview mode receives the same content-growth behavior as the published responsive renderer.
- No database migration or content model change was introduced.

## Validation
- TypeScript/TSX transpile diagnostics: 0 errors.
- CSS brace validation: balanced.
- Bento layout stress test: 50 widgets, desktop/tablet/mobile collision-free.
- Responsive CSS browser simulation: mobile 390px uses 4 columns, stored mobile rows/placements, and content growth without hidden scroll containers.
