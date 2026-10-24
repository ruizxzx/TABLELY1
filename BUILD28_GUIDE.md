# TABLELY Build 28 — Smart Onboarding & QR 2.0

Build 28 adds five connected capabilities while retaining the existing restaurant, branch, menu, payment, session and customer-ordering architecture.

## Included capabilities

1. **Menu importer** — CSV and XLSX are parsed locally; searchable PDFs are parsed from available text; JPG/PNG/WebP photos and AI-assisted searchable-PDF structuring can use an optional OpenAI-compatible vision/chat endpoint. Identified variants and explicitly listed add-on/modifier groups are mapped to TABLELY's existing menu variant and modifier tables. Imports are previews and are committed as unavailable drafts. Restaurant staff must review and activate imported dishes in Menu.
2. **Self-service onboarding** — restaurant profile, main branch, timezone and opening hours, branding, menu setup, table creation, payment setup, progress resume and launch checklist.
3. **Razorpay setup assistant** — existing restaurant-scoped credentials remain encrypted and managed by the existing payment settings endpoint. The connection test verifies API credentials without creating a charge. Webhook secret presence is reported separately; webhook delivery is not tested by the connection test.
4. **Permanent QR destinations** — each table receives an opaque UUID-backed `/q/{publicQrId}` URL. The resolver checks the table, branch and active restaurant, then redirects to the existing `/r/{slug}/table/{table_code}` customer route. Existing legacy QR URLs remain supported.
5. **Branded QR print tools** — multiple templates, restaurant logo and colours, per-table PNG, bulk PNG downloads and browser print-to-PDF in A4/A5/A6/4x6/custom sizes.

## Required migration

Build 28 adds:

`supabase/migrations/202610240004_build28_smart_onboarding_qr_menu_import.sql`

This is an additive migration. It adds onboarding/profile fields, branch business-hours data, stable table QR IDs, menu draft state, import job history/private storage and owner-only idempotent onboarding table creation.

**Do not deploy based solely on the presence of this file.** First reconcile the Build 27 migration state with the target Supabase project's migration history, then apply the migration in a staging project and run the checks below. The migration has not been applied to any remote database as part of this source package.

## Environment configuration

The existing Supabase, Razorpay and `TABLELY_ENCRYPTION_KEY` settings remain required by their existing workflows. Build 28 optionally uses:

```dotenv
TABLELY_MENU_AI_BASE_URL=https://api.openai.com/v1
TABLELY_MENU_AI_API_KEY=
TABLELY_MENU_AI_MODEL=gpt-6-luna
```

`TABLELY_MENU_AI_API_KEY` falls back to `OPENAI_API_KEY` when unset. The default OpenAI model is `gpt-6-luna`; the adapter calls the OpenAI-compatible `/chat/completions` endpoint and sends `reasoning_effort: none` for GPT-6 models. Other compatible providers can override the model and base URL. The provider must accept text and image URL content. Do not expose this key through `NEXT_PUBLIC_*` variables.

If no AI provider is configured, CSV/XLSX and searchable-PDF deterministic parsing remain available. Image-based AI extraction and AI-assisted PDF structuring will return a clear configuration error. Scanned PDFs are not OCR-processed automatically; upload page images as JPG/PNG/WebP when AI extraction is configured. Legacy binary `.xls` must be saved as `.xlsx` or CSV.

## Upload and extraction constraints

- Menu import upload limit: 20 MB.
- Image upload limit: 8 MB.
- Maximum selected menu items per import: 500.
- XLSX expanded-content limits are enforced by the parser.
- Imported rows are stored as drafts (`is_available=false`, `is_draft=true`).
- Source files are stored in the private `menu-imports` bucket.
- Menu items are not published automatically.

The PDF text parser is intentionally heuristic. Complex multi-column PDFs may need manual review or conversion to a structured spreadsheet/image. AI extraction confidence is a review cue, not a guarantee of correctness.

## Onboarding behaviour

Existing organizations are marked as already onboarded by the migration so current customers are not redirected into the new setup wizard. New restaurant owners can resume setup using server-persisted progress. Counter payments can be retained while online payments are configured later. The owner may explicitly defer menu, tables or online payment setup and complete those steps from the existing dashboard afterward.

The onboarding flow configures the current/main branch; additional branches continue to be managed through the existing branch management UI.

## Razorpay setup behaviour

The setup assistant uses the existing restaurant payment settings and credential encryption. The connection test calls the Razorpay order-list API using the supplied/saved credentials and does not create a charge. A valid API credential result is not proof that webhook delivery works. Configure the existing `/api/payments/webhook` endpoint in the merchant dashboard and verify events separately in Razorpay test mode.

## QR behaviour

New QR codes point to `/q/{uuid}`. The resolver redirects to the established customer menu/table route and does not create a customer session merely because a QR was scanned. Existing QR URLs using restaurant slug and table code remain supported. The Build 28 migration backfills stable QR IDs for existing tables.

## QR printing

PNG files are generated at high resolution and high error correction. The Print/PDF action opens the browser print dialog; choose “Save as PDF” to create a PDF. Print scale, margins and paper-size behaviour depend on the browser and printer driver, so scan-test a physical proof before printing a full batch. The QR image itself remains high-contrast and does not place a logo over its modules.

## Local checks

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run check:migrations
npm run build
```

The Node test suite includes Build 27 regression tests, Build 28 parser tests and repository-level Build 28 contract checks. Static contract tests do not replace PostgreSQL/RLS integration tests, browser-based QR scan tests, Razorpay sandbox verification or staging deployment validation.
