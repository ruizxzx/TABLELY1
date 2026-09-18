-- TABLELY: fix Razorpay checkout -- "column orders.razorpay_order_id does not exist".
--
-- app/api/payments/create, /verify and /webhook all read and write
-- orders.razorpay_order_id / orders.razorpay_payment_id, but no migration
-- ever added those columns (they only ever existed in
-- supabase/BUILDS5_8_SETUP.sql, a one-off script that was never applied /
-- turned into a real migration). Add them now.
--
-- Separately, app/api/payments/create upserts into payment_transactions
-- with `onConflict: 'provider_order_id'`, but only provider_payment_id had
-- a unique index (202609150005). Without a matching unique constraint that
-- upsert fails with "there is no unique or exclusion constraint matching
-- the ON CONFLICT specification" -- the very next error you'd hit once the
-- column above is fixed. Fix both in one pass.

alter table public.orders
  add column if not exists razorpay_order_id text,
  add column if not exists razorpay_payment_id text;

create index if not exists orders_razorpay_order_id_idx
  on public.orders (razorpay_order_id)
  where razorpay_order_id is not null;

-- Partial unique index: provider_order_id is null for manual/at-counter
-- transactions, so it can't be a plain unique column, but every Razorpay
-- transaction row needs one so the ON CONFLICT upsert in
-- app/api/payments/create/route.ts has something to match against.
create unique index if not exists payment_transactions_provider_order_uidx
  on public.payment_transactions (provider_order_id)
  where provider_order_id is not null;

notify pgrst, 'reload schema';
