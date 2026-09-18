# TABLELY Mobile Marketing + Auth Responsiveness Fix

## Scope
- Restore visible mobile navigation on the public landing page.
- Keep Features, Pricing, How it works, Login, and Get started accessible on narrow screens.
- Collapse split authentication screens to one column on phones.
- Improve small-screen footer link layout.
- Prevent horizontal page overflow.
- Keep existing customer, order, payment, branding, analytics, and database behavior unchanged.

## Implementation
- `app/page.tsx`: added a dedicated `mobile-site-links` navigation block.
- `app/globals.css`: added final responsive overrides for marketing navigation, hero, footer, and auth pages.

## Expected mobile behavior
At <= 760px:
- Desktop marketing links are hidden.
- A 5-link mobile navigation is shown below the brand bar.
- Hero primary/secondary actions remain visible.
- Signup split layout becomes a single column.
- Login/signup form controls remain within viewport.

At <= 520px:
- Mobile navigation uses a 2-column layout with a full-width Get started CTA.
- Hero action buttons stack vertically.
- Footer links remain inside the viewport.

## Verification
- Source-level static checks passed.
- Full Next.js build/typecheck not run because `node_modules` is not present and `npm ci` timed out in the execution environment.
