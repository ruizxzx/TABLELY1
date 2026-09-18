-- TABLELY BUILD 21 — COUNTER PAYMENT NOT RECEIVED CANCELLATION REASON
--
-- The Build 21 decide_counter_payment() RPC intentionally records the
-- customer-visible reason COUNTER_PAYMENT_NOT_RECEIVED when a restaurant
-- declines an unpaid PAY_AT_COUNTER order. Build 13.4's CHECK constraint did
-- not yet include that reason, causing the RPC to fail with 23514 before the
-- cancellation could be committed.

begin;

alter table public.orders drop constraint if exists orders_cancellation_reason_check;

alter table public.orders add constraint orders_cancellation_reason_check
  check (
    cancellation_reason is null or cancellation_reason in (
      'CUSTOMER_REQUESTED',
      'RESTAURANT_CANNOT_FULFILL',
      'ITEM_UNAVAILABLE',
      'PAYMENT_ISSUE',
      'OTHER',
      'ONLINE_PAYMENT_FAILED',
      'ONLINE_PAYMENT_TIMEOUT',
      'COUNTER_PAYMENT_NOT_RECEIVED'
    )
  );

create or replace function public.cancellation_reason_label(p_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_code
    when 'CUSTOMER_REQUESTED' then 'Customer requested'
    when 'RESTAURANT_CANNOT_FULFILL' then 'Restaurant cannot fulfill'
    when 'ITEM_UNAVAILABLE' then 'Item unavailable'
    when 'PAYMENT_ISSUE' then 'Payment issue'
    when 'ONLINE_PAYMENT_FAILED' then 'Online payment failed'
    when 'ONLINE_PAYMENT_TIMEOUT' then 'Online payment timed out'
    when 'COUNTER_PAYMENT_NOT_RECEIVED' then 'Counter payment not received'
    when 'OTHER' then 'Other'
    else coalesce(p_code, 'Unspecified reason')
  end;
$$;

commit;

notify pgrst, 'reload schema';
