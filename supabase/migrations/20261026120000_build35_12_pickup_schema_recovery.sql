-- TABLELY BUILD 35.12 — Recover pickup verification schema prerequisites
-- Idempotently restores the Build 35.3 columns used by pickup handoff RPCs.

begin;

alter table public.order_fulfillment_details
  add column if not exists pickup_code_hash text,
  add column if not exists delivery_otp_hash text,
  add column if not exists pickup_code_expires_at timestamptz,
  add column if not exists delivery_otp_expires_at timestamptz,
  add column if not exists pickup_code_used_at timestamptz,
  add column if not exists delivery_otp_used_at timestamptz,
  add column if not exists pickup_verification_attempts integer not null default 0,
  add column if not exists delivery_verification_attempts integer not null default 0;

update public.order_fulfillment_details
set pickup_verification_attempts = least(greatest(coalesce(pickup_verification_attempts, 0), 0), 5),
    delivery_verification_attempts = least(greatest(coalesce(delivery_verification_attempts, 0), 0), 5)
where pickup_verification_attempts is null
   or delivery_verification_attempts is null
   or pickup_verification_attempts not between 0 and 5
   or delivery_verification_attempts not between 0 and 5;

alter table public.order_fulfillment_details
  alter column pickup_verification_attempts set default 0,
  alter column pickup_verification_attempts set not null,
  alter column delivery_verification_attempts set default 0,
  alter column delivery_verification_attempts set not null;

alter table public.order_fulfillment_details
  drop constraint if exists fulfillment_pickup_attempts_check,
  drop constraint if exists fulfillment_delivery_attempts_check,
  drop constraint if exists order_fulfillment_details_fulfillment_status_check;
alter table public.order_fulfillment_details
  add constraint fulfillment_pickup_attempts_check
    check (pickup_verification_attempts between 0 and 5),
  add constraint fulfillment_delivery_attempts_check
    check (delivery_verification_attempts between 0 and 5),
  add constraint order_fulfillment_details_fulfillment_status_check
    check (fulfillment_status in (
      'NOT_STARTED', 'WAITING_FOR_PICKUP', 'READY_FOR_PICKUP', 'PICKED_UP',
      'WAITING_FOR_DRIVER', 'ASSIGNED', 'READY_FOR_DISPATCH', 'OUT_FOR_DELIVERY',
      'DELIVERED', 'DELIVERY_FAILED', 'RETURNED_TO_RESTAURANT', 'CANCELLED'
    ));

update public.order_fulfillment_details ofd
set fulfillment_status = case
      when ofd.fulfillment_type = 'PICKUP' then 'READY_FOR_PICKUP'
      when ofd.fulfillment_type = 'DELIVERY' then 'READY_FOR_DISPATCH'
      else ofd.fulfillment_status
    end,
    updated_at = now()
from public.orders o
where o.id = ofd.order_id
  and o.status = 'READY'
  and (
    (ofd.fulfillment_type = 'PICKUP' and ofd.fulfillment_status = 'WAITING_FOR_PICKUP')
    or (ofd.fulfillment_type = 'DELIVERY' and ofd.fulfillment_status in ('WAITING_FOR_DRIVER', 'ASSIGNED'))
  );

notify pgrst, 'reload schema';
commit;