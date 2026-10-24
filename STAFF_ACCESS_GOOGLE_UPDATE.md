# Staff access + Google login update

- Added separate Kitchen and Waiter capabilities on staff records.
- Staff invitation profiles: Waiter only, Kitchen only, Kitchen + Waiter, Manager.
- Existing staff can be changed between those profiles by Owner.
- Database order transitions enforce capabilities, not only UI visibility.
- Kitchen + Waiter users see/use both operational areas.
- Added Settings landing page with a general Sign out action.
- Added Continue with Google to login and signup via Supabase Auth.
- Google provider still requires configuration in Supabase and Google Cloud; see GOOGLE_LOGIN_SETUP.md.
