# Phase 5 Vercel Build Fix

Targeted fix for Vercel production builds.

## Root cause

The Next.js root `tsconfig.json` included `**/*.ts`, which caused Vercel's Next.js TypeScript check to type-check the Supabase Edge Function under `supabase/functions/send-order-email/`.

That Edge Function uses the Deno runtime and `npm:` imports and is deployed/checked by Supabase, not by the Next.js/Vercel TypeScript build.

## Fix

The root Next.js `tsconfig.json` now excludes:

```json
"supabase/functions"
```

No application routes, components, database migrations, payment logic, checkout logic, or Edge Function source behavior were changed.

## Important

The Supabase Edge Function remains in the repository so it can continue to be deployed by Supabase tooling. This change only prevents the Vercel Next.js build from incorrectly type-checking the Deno function.
