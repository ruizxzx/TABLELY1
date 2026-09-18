# TABLELY Public Content + Contact CMS

This package adds the public Content Control Center for:

- Contact Us
- My Vision
- Privacy Policy
- Terms & Conditions
- Contact / Leads inbox

## Database

Apply the new additive migration:

`supabase/migrations/202609181400_public_content_contact_cms.sql`

The migration creates the public content records, contact submissions, secured admin RPCs, RLS configuration, and seed content.

## Admin

After the migration is applied, platform admins can use:

- `/admin/content` for public content
- `/admin/contacts` for enterprise leads

Each content page supports draft, preview, publish, and unpublish. My Vision also supports founder image upload/replacement/removal.

## Contact email

The database/Admin inbox is the authoritative destination for Contact Us submissions. The public contact address is `krishsarkar456@gmail.com`.

Optional server-side notification can be enabled with:

`RESEND_API_KEY`
`RESEND_FROM_EMAIL`

If these variables are not configured, contact submissions still work and remain in the Admin inbox; no inquiry depends on outbound email delivery.

## Security

Global content writes and lead management use the existing `is_platform_admin()` authorization. Public visitors can read only published content through the restricted public-content RPC and can submit Contact Us messages without being able to read them back.

## Verification limitation

The package was statically checked in this build environment, but the target Supabase migration and full Next.js dependency-based typecheck/lint/build were not executed here. Apply the migration and run the project's normal CI/build checks in the development environment before production use.
