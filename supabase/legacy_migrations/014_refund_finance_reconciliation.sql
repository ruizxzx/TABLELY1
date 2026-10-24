-- Sellora refund/finance reconciliation.
-- Creator-side refund reversals are based on seller net, not gross refund amount.
-- Safe to re-run. Customer refund amounts remain stored in approved_amount_minor.

alter table public.refunds
  add column if not exists creator_reversal_minor bigint not null default 0;

create index if not exists refunds_order_status_created_idx
  on public.refunds(order_id, status, created_at);

with succeeded as (
  select
    r.id,
    r.order_id,
    r.approved_amount_minor,
    coalesce(r.completed_at, r.created_at) as effective_at,
    coalesce(o.gross_amount_minor, greatest(0, o.gross_amount * 100)) as gross_minor,
    coalesce(o.seller_net_minor, greatest(0, o.seller_net * 100)) as seller_net_minor,
    sum(r.approved_amount_minor) over (
      partition by r.order_id
      order by coalesce(r.completed_at, r.created_at), r.id
      rows between unbounded preceding and current row
    ) as cumulative_refund_minor
  from public.refunds r
  join public.orders o on o.id = r.order_id
  where r.status = 'succeeded'
), calc_base as (
  select
    *,
    least(gross_minor, cumulative_refund_minor) as capped_cumulative_refund
  from succeeded
  where gross_minor > 0
), calc as (
  select
    *,
    least(
      seller_net_minor,
      round((seller_net_minor * capped_cumulative_refund)::numeric / gross_minor)
    )::bigint as target_cumulative_reversal
  from calc_base
), calc_with_prior as (
  select
    *,
    coalesce(
      lag(target_cumulative_reversal) over (partition by order_id order by effective_at, id),
      0
    ) as prior_cumulative_reversal
  from calc
)
update public.refunds r
set creator_reversal_minor = greatest(0, c.target_cumulative_reversal - c.prior_cumulative_reversal)::bigint
from calc_with_prior c
where r.id = c.id;

update public.ledger_entries l
set
  amount_minor = r.creator_reversal_minor,
  description = 'Creator net reversal for customer refund',
  metadata = jsonb_build_object(
    'refund_id', r.id,
    'gross_refund_minor', r.approved_amount_minor,
    'creator_reversal_minor', r.creator_reversal_minor,
    'basis', 'seller_net_proportional'
  )
from public.refunds r
where l.idempotency_key = 'refund:' || r.id
  and r.status = 'succeeded';
