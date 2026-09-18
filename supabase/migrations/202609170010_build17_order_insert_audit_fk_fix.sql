-- TABLELY BUILD 17.10 — order insert / order_events FK hotfix
--
-- Root cause:
-- build17_attach_order_session() is a BEFORE INSERT trigger on public.orders.
-- Writing an order_events row from that trigger references NEW.id before the
-- parent public.orders row exists, which violates order_events_order_id_fkey.
--
-- Fix:
-- Keep session attachment in the BEFORE trigger, but move the audit event to
-- an AFTER INSERT trigger where the parent order row already exists.
-- This is additive and does not rewrite any Build 14/15/16 security RPCs.

begin;

create or replace function public.build17_attach_order_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  if not exists (
    select 1
    from public.tables
    where id = new.table_id
      and branch_id = new.branch_id
  ) then
    raise exception 'Order table does not belong to the order branch';
  end if;

  perform 1
  from public.tables
  where id = new.table_id
  for update;

  select ts.id
    into v_session_id
  from public.table_sessions as ts
  where ts.table_id = new.table_id
    and ts.status = 'ACTIVE'
  order by ts.opened_at desc
  limit 1;

  if v_session_id is null then
    insert into public.table_sessions(branch_id, table_id, status, occupancy_count)
    values (new.branch_id, new.table_id, 'ACTIVE', 0)
    returning id into v_session_id;
  end if;

  new.table_session_id := v_session_id;
  new.received_at := coalesce(new.received_at, now());
  return new;
end;
$$;

drop trigger if exists build17_attach_order_session on public.orders;
create trigger build17_attach_order_session
before insert on public.orders
for each row
execute function public.build17_attach_order_session();

create or replace function public.build17_audit_session_open_after_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.table_session_id is not null then
    insert into public.order_events(
      order_id,
      branch_id,
      event_type,
      actor_user_id,
      metadata
    )
    select
      new.id,
      new.branch_id,
      'TABLE_SESSION_OPENED',
      auth.uid(),
      jsonb_build_object(
        'table_id', new.table_id,
        'session_id', new.table_session_id,
        'source', 'BUILD17_ORDER_INSERT'
      )
    where not exists (
      select 1
      from public.order_events as oe
      where oe.order_id = new.id
        and oe.event_type = 'TABLE_SESSION_OPENED'
    )
      and not exists (
        select 1
        from public.order_events as oe
        where oe.order_id <> new.id
          and oe.event_type = 'TABLE_SESSION_OPENED'
          and coalesce(oe.metadata ->> 'session_id', '') = new.table_session_id::text
      );
  end if;

  return new;
end;
$$;

drop trigger if exists build17_audit_session_open_after_order on public.orders;
create trigger build17_audit_session_open_after_order
after insert on public.orders
for each row
execute function public.build17_audit_session_open_after_order();

revoke execute on function public.build17_audit_session_open_after_order() from anon, authenticated, public;
alter function public.build17_audit_session_open_after_order() set search_path = public;

commit;
