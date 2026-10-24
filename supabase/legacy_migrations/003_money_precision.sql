-- Sellora Build 5 precision hardening.
-- Product/order display amounts remain in major units for backwards compatibility.
-- These columns preserve exact provider minor-unit financial snapshots (e.g. INR paise).

alter table public.orders
  add column if not exists gross_amount_minor bigint,
  add column if not exists payment_fee_minor bigint not null default 0,
  add column if not exists platform_fee_minor bigint not null default 0,
  add column if not exists seller_net_minor bigint not null default 0;

update public.orders
set gross_amount_minor = gross_amount * 100
where gross_amount_minor is null;

update public.orders
set payment_fee_minor = coalesce(payment_fee, 0) * 100
where payment_fee_minor = 0 and coalesce(payment_fee, 0) > 0;

update public.orders
set platform_fee_minor = coalesce(platform_fee, 0) * 100
where platform_fee_minor = 0 and coalesce(platform_fee, 0) > 0;

update public.orders
set seller_net_minor = greatest(0, coalesce(gross_amount_minor, gross_amount * 100) - payment_fee_minor - platform_fee_minor)
where seller_net_minor = 0 and gross_amount > 0;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_money_minor_nonnegative') then
    alter table public.orders
      add constraint orders_money_minor_nonnegative
      check (
        coalesce(gross_amount_minor, 0) >= 0
        and payment_fee_minor >= 0
        and platform_fee_minor >= 0
        and seller_net_minor >= 0
      );
  end if;
end $$;
