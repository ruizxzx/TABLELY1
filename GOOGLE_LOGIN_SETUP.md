# Google login setup

Tablely now exposes **Continue with Google** on login and signup. The application uses Supabase Auth OAuth and its existing `/auth/callback` PKCE flow.

## Supabase
1. Open Authentication → Providers → Google.
2. Enable Google and enter your Google OAuth Client ID and Client Secret.
3. In Supabase Authentication URL Configuration, add the local redirect URL:
   `http://localhost:3001/auth/callback`
4. When production is ready, add the production callback URL:
   `https://YOUR-DOMAIN/auth/callback`

## Google Cloud
Create a Web application OAuth client and add your app origin under Authorized JavaScript origins. Add the Supabase project's Google provider callback URL as an Authorized redirect URI. Supabase shows the exact callback URI in the Google provider configuration.

After enabling the provider, the button is ready; no Google client secret is placed in Tablely's browser environment variables.
