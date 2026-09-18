# CUSTOMER MOBILE RESPONSIVE FIX

## Scope
Customer table-ordering menu and shared customer shell.

## Changes
- Added an explicit mobile viewport configuration in `app/layout.tsx`.
- Customer navigation becomes a visible 3-column mobile grid instead of relying on horizontal scrolling.
- Navigation icons remain visible on mobile.
- Food cards remain compact/horizontal at narrow phone widths.
- `Add` and `Customize` actions are true flex buttons/links with centered content and consistent sizing.
- Floating cart becomes fixed on phones so `View cart` remains visible while browsing.
- Mobile table-service panel uses the lower viewport rather than covering the navigation.
- No ordering, cart, session, payment, coupon, or database logic was changed.

## Validation
- Static JSX/CSS structure checks: PASS
- No customer ordering database code changed: PASS
- Full Next build/typecheck: NOT RUN (dependencies are not installed in the uploaded ZIP).
