# INSTALY Link Hub P0 Fixes — Build 15

This build is based on Build 14 and contains targeted fixes for the three requested P0 areas.

## 1. Mobile editor scrolling

- Normal touch swipes are allowed to remain native scrolling gestures.
- Touch block drag uses an explicit move handle rather than long-pressing the whole card.
- Normal touches on a block only select it and remain available for native scrolling.
- The move handle uses a captured custom gesture with `touch-action: none`.
- Resize handles continue to use captured custom gestures with `touch-action: none`.
- Mouse drag/resize behavior is kept on the existing path.
- Pending touch-drag timers are isolated from saved Bento state.

## 2. New-account starter layout

- New/empty Bento documents receive a deterministic starter layout per viewport.
- Desktop: 12 columns; Tablet: 8; Mobile: 4.
- Profile is placed first, enabled content is packed contiguously, and the branding footer follows the content.
- Paired desktop/tablet content uses balanced half-width columns.
- A lone final desktop/tablet content block uses the full row instead of leaving an empty half-grid.
- Disabled blocks are excluded from starter geometry.
- Existing non-empty creator layouts continue through the existing arrangement path; the new starter packing function is not applied to them.

## 3. Link Hub onboarding

- The Link Hub-specific onboarding now contains four focused steps: visual direction, platform selection, profile URLs/custom links, and profile details.
- Profile photo selection and crop UI are included in the onboarding flow.
- A live side preview updates with the selected theme, profile information, socials, custom links, store CTA, and newsletter treatment.
- Social selection keeps featured platforms concise while allowing the full platform catalog to be revealed.
- Custom links support add/edit/remove with validation before completion.
- Completion generates/synchronizes the canonical Bento block document and persists it through the existing store API.
- The onboarding remains separate from global signup/payment onboarding.
- Mobile-specific onboarding layout rules are included.

## Validation performed in the build environment

- TypeScript/TSX parser diagnostics: passed for changed TypeScript files.
- CSS parsing with PostCSS: passed.
- Runtime test of `buildHubBentoBlocks`: passed for new-account desktop/tablet/mobile starter geometry, lone-content packing, and preservation of existing custom geometry.

A full `npm run build` was not possible in this environment because the uploaded dependency tree is incomplete and package installation could not finish. No claim of a complete production build verification is made.
