# Build 3/4 Fix Status

The current checkout RPC repair fixes both previously observed database errors:

1. `function gen_random_bytes(integer) does not exist` by using `extensions.gen_random_bytes(...)`.
2. `column reference "order_number" is ambiguous` by avoiding unqualified generated columns inside the `RETURNS TABLE` PL/pgSQL function.

## Existing project repair

Run `supabase/BUILD3_4_PATCH_GEN_RANDOM_BYTES.sql` once in the existing Supabase project, or use the more specifically named `BUILD3_4_PATCH_ORDER_NUMBER_AMBIGUITY.sql`. Neither script drops functions with CASCADE or removes dependent RLS policies.

Then retry customer checkout.
