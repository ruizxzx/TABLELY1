-- TABLELY BUILD 13.4 — Realtime notifications + owner branch preferences
-- Safe additive migration. Does not alter payment/order state semantics.

begin;

-- ---------------------------------------------------------------------------
-- Owner notification preferences
-- ---------------------------------------------------------------------------
create table if not exists public.owner_notification_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, owner_user_id, branch_id)
);

create index if not exists owner_notification_preferences_owner_idx
  on public.owner_notification_preferences(owner_user_id, organization_id, enabled);
create index if not exists owner_notification_preferences_branch_idx
  on public.owner_notification_preferences(branch_id, enabled);

alter table public.owner_notification_preferences enable row level security;
revoke all on public.owner_notification_preferences from anon, public;

drop policy if exists owner_notification_preferences_select on public.owner_notification_preferences;
create policy owner_notification_preferences_select
on public.owner_notification_preferences
for select to authenticated
using (
  owner_user_id = auth.uid()
  and public.is_org_owner(organization_id)
);

drop policy if exists owner_notification_preferences_insert on public.owner_notification_preferences;
create policy owner_notification_preferences_insert
on public.owner_notification_preferences
for insert to authenticated
with check (
  owner_user_id = auth.uid()
  and public.is_org_owner(organization_id)
  and exists (
    select 1 from public.branches b
    where b.id = branch_id and b.organization_id = organization_id
  )
);

drop policy if exists owner_notification_preferences_update on public.owner_notification_preferences;
create policy owner_notification_preferences_update
on public.owner_notification_preferences
for update to authenticated
using (owner_user_id = auth.uid() and public.is_org_owner(organization_id))
with check (
  owner_user_id = auth.uid()
  and public.is_org_owner(organization_id)
  and exists (
    select 1 from public.branches b
    where b.id = branch_id and b.organization_id = organization_id
  )
);

create or replace function public.set_owner_notification_preference(
  p_branch_id uuid,
  p_enabled boolean
)
returns table(branch_id uuid, enabled boolean)
language plpgsql
security definer
set search_path=public
as $$
declare
  v_org_id uuid;
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'Not authenticated' using errcode='42501';
  end if;

  select b.organization_id
    into v_org_id
  from public.branches b
  join public.organizations o on o.id=b.organization_id
  where b.id=p_branch_id
    and o.owner_id=v_owner;

  if v_org_id is null then
    raise exception 'You are not the owner of this branch' using errcode='42501';
  end if;

  insert into public.owner_notification_preferences(organization_id,owner_user_id,branch_id,enabled)
  values(v_org_id,v_owner,p_branch_id,coalesce(p_enabled,false))
  on conflict (organization_id,owner_user_id,branch_id)
  do update set enabled=excluded.enabled, updated_at=now();

  return query
  select p.branch_id,p.enabled
  from public.owner_notification_preferences p
  where p.organization_id=v_org_id
    and p.owner_user_id=v_owner
    and p.branch_id=p_branch_id;
end;
$$;

revoke all on function public.set_owner_notification_preference(uuid,boolean) from public, anon;
grant execute on function public.set_owner_notification_preference(uuid,boolean) to authenticated;
alter function public.set_owner_notification_preference(uuid,boolean) set search_path=public;

-- ---------------------------------------------------------------------------
-- Keep owner preference timestamps correct.
-- ---------------------------------------------------------------------------
drop trigger if exists owner_notification_preferences_set_updated_at on public.owner_notification_preferences;
create trigger owner_notification_preferences_set_updated_at
before update on public.owner_notification_preferences
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Notification fan-out helper.
-- Non-owner recipients remain branch-local. Owners are organization-level and
-- receive the source branch only when they explicitly enabled that branch.
-- A single canonical OWNER staff row is used so history + realtime share one
-- recipient id even when ownership has more than one staff row.
-- ---------------------------------------------------------------------------
create or replace function public.create_staff_notification(
  p_branch_id uuid,
  p_roles public.staff_role[],
  p_type text,
  p_title text,
  p_message text,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_exclude_user uuid default null
)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  v_count integer := 0;
  v_org_id uuid;
  v_owner_user_id uuid;
  v_owner_staff_id uuid;
  v_branch_name text;
begin
  select b.organization_id,b.name,o.owner_id
    into v_org_id,v_branch_name,v_owner_user_id
  from public.branches b
  join public.organizations o on o.id=b.organization_id
  where b.id=p_branch_id;

  if v_org_id is null then
    return 0;
  end if;

  -- Branch-local non-owner recipients.
  insert into public.notifications(
    branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata
  )
  select
    p_branch_id,s.id,p_type,p_title,p_message,p_entity_type,p_entity_id,
    coalesce(p_metadata,'{}'::jsonb)
  from public.staff s
  where s.branch_id=p_branch_id
    and s.active=true
    and s.role <> 'OWNER'::public.staff_role
    and s.role = any(coalesce(p_roles, '{}'::public.staff_role[]))
    and (p_exclude_user is null or s.user_id <> p_exclude_user);

  get diagnostics v_count = row_count;

  -- Owner is selected per source branch and receives the event through a
  -- canonical organization owner staff row.
  if 'OWNER'::public.staff_role = any(coalesce(p_roles, '{}'::public.staff_role[]))
     and v_owner_user_id is not null
     and (p_exclude_user is null or v_owner_user_id <> p_exclude_user)
  then
    select s.id into v_owner_staff_id
    from public.staff s
    where s.organization_id=v_org_id
      and s.user_id=v_owner_user_id
      and s.role='OWNER'::public.staff_role
      and s.active=true
    order by case when s.branch_id=p_branch_id then 0 else 1 end, s.created_at, s.id
    limit 1;

    if v_owner_staff_id is not null and exists (
      select 1
      from public.owner_notification_preferences pref
      where pref.organization_id=v_org_id
        and pref.owner_user_id=v_owner_user_id
        and pref.branch_id=p_branch_id
        and pref.enabled=true
    ) then
      insert into public.notifications(
        branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata
      ) values (
        p_branch_id,
        v_owner_staff_id,
        p_type,
        format('Branch %s · %s',v_branch_name,p_title),
        p_message,
        p_entity_type,
        p_entity_id,
        coalesce(p_metadata,'{}'::jsonb) || jsonb_build_object('source_branch_name',v_branch_name,'owner_scoped',true)
      );
      v_count := v_count + 1;
    end if;
  end if;

  return v_count;
end;
$$;

grant execute on function public.create_staff_notification(uuid,public.staff_role[],text,text,text,text,uuid,jsonb,uuid) to authenticated, service_role;
revoke execute on function public.create_staff_notification(uuid,public.staff_role[],text,text,text,text,uuid,jsonb,uuid) from anon, public;
alter function public.create_staff_notification(uuid,public.staff_role[],text,text,text,text,uuid,jsonb,uuid) set search_path=public;

-- ---------------------------------------------------------------------------
-- Complete order notification fan-out.
-- ---------------------------------------------------------------------------
create or replace function public.notify_order_status_change()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_table integer;
  v_order bigint;
  v_msg text;
begin
  select t.table_number into v_table
  from public.tables t where t.id=coalesce(NEW.table_id,OLD.table_id);
  v_order:=coalesce(NEW.order_number,OLD.order_number);

  if TG_OP='INSERT' then
    perform public.create_staff_notification(
      NEW.branch_id,
      ARRAY['OWNER','MANAGER']::public.staff_role[],
      'ORDER_NEW',
      'New order',
      format('Order #%s received from Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—')),
      'ORDER',NEW.id,'{}'::jsonb,null
    );
    return NEW;
  end if;

  if NEW.status::text=OLD.status::text and NEW.payment_status::text=OLD.payment_status::text then
    return NEW;
  end if;

  if NEW.status::text='ACCEPTED' then
    v_msg:=format('Order #%s accepted. Start preparing Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—'));
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'ORDER_ACCEPTED','Start preparing',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','ACCEPTED')
    from public.staff s
    where s.branch_id=NEW.branch_id and s.active=true and s.role<>'OWNER'::public.staff_role and s.can_kitchen=true;
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER']::public.staff_role[],'ORDER_ACCEPTED','Order accepted',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','ACCEPTED'),null);

  elsif NEW.status::text='PREPARING' then
    v_msg:=format('Order #%s is now being prepared for Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—'));
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'ORDER_PREPARING','Order preparing',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','PREPARING')
    from public.staff s
    where s.branch_id=NEW.branch_id and s.active=true and s.role<>'OWNER'::public.staff_role and s.can_kitchen=true;
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_PREPARING','Order preparing',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','PREPARING'),null);

  elsif NEW.status::text='READY' then
    v_msg:=format('Order #%s is ready at Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—'));
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'ORDER_READY','Order ready',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','READY')
    from public.staff s
    where s.branch_id=NEW.branch_id and s.active=true and s.role<>'OWNER'::public.staff_role and (s.can_waiter=true or s.role='MANAGER'::public.staff_role);
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER']::public.staff_role[],'ORDER_READY','Order ready',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','READY'),null);

  elsif NEW.status::text='SERVED' then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_SERVED','Order served',format('Order #%s was served at Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','SERVED'),null);

  elsif NEW.status::text='COMPLETED' then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_COMPLETED','Order completed',format('Order #%s is completed.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','COMPLETED'),null);

  elsif NEW.status::text='CANCELLED' then
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'ORDER_CANCELLED','Order cancelled',format('Order #%s was cancelled.',coalesce(v_order::text,'—')),'ORDER',NEW.id,
      jsonb_build_object('order_status','CANCELLED','cancellation_reason',NEW.cancellation_reason)
    from public.staff s
    where s.branch_id=NEW.branch_id and s.active=true and s.role<>'OWNER'::public.staff_role;
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER']::public.staff_role[],'ORDER_CANCELLED','Order cancelled',format('Order #%s was cancelled.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','CANCELLED','cancellation_reason',NEW.cancellation_reason),null);
  end if;

  if NEW.payment_status::text<>OLD.payment_status::text and NEW.payment_status::text='PAID' then
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'PAYMENT_PAID','Payment received',format('Order #%s is marked paid.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('payment_status','PAID')
    from public.staff s
    where s.branch_id=NEW.branch_id and s.active=true and s.role<>'OWNER'::public.staff_role and (s.can_waiter=true or s.role='MANAGER'::public.staff_role);
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER']::public.staff_role[],'PAYMENT_PAID','Payment received',format('Order #%s is marked paid.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('payment_status','PAID'),null);
  end if;

  return NEW;
end;
$$;

drop trigger if exists orders_notification_fanout on public.orders;
create trigger orders_notification_fanout
after insert or update of status,payment_status on public.orders
for each row execute function public.notify_order_status_change();


-- Service requests created in older migrations used direct notification inserts.
-- Route that trigger through the same scoped helper so Owner preferences apply.
create or replace function public.notify_service_request()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_table integer;
begin
  if TG_OP='INSERT' then
    select table_number into v_table from public.tables where id=NEW.table_id;
  end if;

  if TG_OP='INSERT' and NEW.status='OPEN' then
    perform public.create_staff_notification(
      NEW.branch_id,
      ARRAY['OWNER','MANAGER','WAITER']::public.staff_role[],
      'SERVICE_REQUEST',
      'Service request',
      format('Table %s requested %s.',coalesce(v_table::text,'—'),replace(lower(NEW.type),'_',' ')),
      'SERVICE_REQUEST',NEW.id,jsonb_build_object('type',NEW.type),null
    );
  elsif TG_OP='UPDATE' and OLD.status<>NEW.status and NEW.status in ('RESOLVED','CANCELLED') then
    perform public.create_staff_notification(
      NEW.branch_id,
      ARRAY['OWNER','MANAGER']::public.staff_role[],
      'SERVICE_RESOLVED',
      'Service request resolved',
      format('Table %s service request was %s.',coalesce(v_table::text,'—'),lower(NEW.status)),
      'SERVICE_REQUEST',NEW.id,jsonb_build_object('status',NEW.status),NEW.resolved_by
    );
  end if;

  return NEW;
end;
$$;

drop trigger if exists service_request_notification_fanout on public.service_requests;
create trigger service_request_notification_fanout
after insert or update of status on public.service_requests
for each row execute function public.notify_service_request();

notify pgrst,'reload schema';

commit;
