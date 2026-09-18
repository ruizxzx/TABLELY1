# Vercel Web Analytics

TABLELY now includes `@vercel/analytics` in the root layout.

## Enable it on Vercel

1. Open the TABLELY project in Vercel.
2. Open **Analytics**.
3. Enable **Web Analytics** for the project.
4. Deploy this build.
5. Visit the deployed site and browse a few pages.
6. Return to Vercel → **Analytics** to see traffic.

The Analytics component automatically tracks page views and client-side navigation in the deployed Vercel app.

## Local development

Vercel Web Analytics does not send production analytics data from normal local development.

## Package

`@vercel/analytics` is pinned to `2.0.1`.
