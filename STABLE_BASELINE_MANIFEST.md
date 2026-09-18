# TABLELY Stable Baseline Manifest

## Package

`TABLELY-STABLE-BUILD19.4-BUILD20.1-CLEAN.zip`

## Baseline

Build 19.4 + Build 20.1 customer browser isolation baseline.

## Cleaning performed

The application source, migrations, package files, components, API routes, and relevant current documentation were preserved from the supplied archive.

Removed only files that were clearly stale, generated, redundant, or obsolete setup artifacts:

- `tsconfig.tsbuildinfo` — generated TypeScript cache.
- `create_009.sql` — standalone Build 17.9 close-session hotfix already represented by the migration history; keeping it beside the canonical migrations could cause accidental out-of-order execution.
- Old standalone `supabase/*.sql` setup/hotfix scripts from Builds 2–8 — superseded by the canonical `supabase/migrations/` history and unsafe as a future-AI execution source.
- Historical Build 3–16 status/audit/UI notes whose information is consolidated into the current master context and whose older wording could conflict with the current architecture.

## Added/updated documentation

- `TABLELY_CURRENT_STATE_MASTER_CONTEXT.md` — master preservation/development context.
- `README.md` — updated to describe the current stable baseline rather than the old Build 1–8 state.
- `STABLE_BASELINE_MANIFEST.md` — explains exactly what was removed and why.

## Safety promise for this packaging step

No application source file was intentionally modified. The cleanup only removes stale/generated files and updates documentation so a future AI does not mistake legacy setup material for the current canonical architecture.
