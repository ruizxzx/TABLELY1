# Admin Trial Invitations

Super Admin now has an **Invite trial account** tool.

## What it does

- Enter a restaurant owner's email.
- Choose Starter, Growth, or Pro.
- Choose a trial/access window from 1 to 3650 days.
- If the email already owns a restaurant, the subscription is applied immediately.
- If the email is new, a pending invite is stored and is automatically applied when that user completes restaurant onboarding.
- With `SUPABASE_SERVICE_ROLE_KEY` configured server-side, Tablely also sends the Supabase auth invitation email.
- Without the service-role key, the admin screen provides the signup URL so the link can be shared manually.

## Controls

Super Admin can:

- Cancel a pending trial invitation.
- Change an existing restaurant plan.
- Change subscription status.
- Change trial start/end times.
- Change active-period start/end times.

There is no refund workflow.

## Migration

Run once in the existing Supabase project:

`supabase/migrations/202609141900_admin_trial_invites.sql`

The migration is additive and reuses the existing organization subscription model.
