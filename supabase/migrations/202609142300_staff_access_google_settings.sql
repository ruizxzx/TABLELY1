-- Tablely: staff dual-access permissions.
-- Adds independent Kitchen/Waiter capabilities while preserving the existing staff_role enum.

alter table public.staff add column if not exists can_kitchen boolean not null default false;
alter table public.staff add column if not exists can_waiter boolean not null default false;

update public.staff
set can_kitchen = case when role in ('OWNER','MANAGER','KITCHEN') then true else can_kitchen end,
    can_waiter = case when role in ('OWNER','MANAGER','WAITER') then true else can_waiter end;

update public.staff
set can_kitchen = true, can_waiter = true
where role in ('OWNER','MANAGER');

alter table public.staff drop constraint if exists staff_at_least_one_capability;
alter table public.staff add constraint staff_at_least_one_capability check (active = false or can_kitchen or can_waiter);

alter table public.staff_invitations add column if not exists can_kitchen boolean not null default false;
alter table public.staff_invitations add column if not exists can_waiter boolean not null default false;

update public.staff_invitations
set can_kitchen = case when role in ('MANAGER','KITCHEN') then true else can_kitchen end,
    can_waiter = case when role in ('MANAGER','WAITER') then true else can_waiter end;

-- New invitation function keeps the original signature intact for older callers.
create or replace function public.create_staff_invitation(
  p_branch_id uuid,
  p_email text,
  p_role public.staff_role,
  p_can_kitchen boolean default null,
  p_can_waiter boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,extensions
as $$
declare
  v_actor public.staff%rowtype;
  v_branch public.branches%rowtype;
  v_token text;
  v_row public.staff_invitations%rowtype;
  v_email text:=lower(trim(coalesce(p_email,'')));
  v_kitchen boolean:=coalesce(p_can_kitchen, p_role in ('OWNER','MANAGER','KITCHEN'));
  v_waiter boolean:=coalesce(p_can_waiter, p_role in ('OWNER','MANAGER','WAITER'));
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select s.* into v_actor from public.staff s where s.user_id=auth.uid() and s.active=true and s.role='OWNER' order by s.created_at limit 1;
  if v_actor.id is null then raise exception 'Only the owner can invite staff' using errcode='42501'; end if;
  select b.* into v_branch from public.branches b where b.id=p_branch_id and b.organization_id=v_actor.organization_id;
  if v_branch.id is null then raise exception 'Invalid branch' using errcode='42501'; end if;
  if p_role not in ('MANAGER','WAITER','KITCHEN') then raise exception 'Invalid staff role'; end if;
  if not (v_kitchen or v_waiter) then raise exception 'At least one operational permission is required'; end if;
  if v_email='' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Invalid email address'; end if;
  if exists(select 1 from public.staff es join auth.users au on au.id=es.user_id where es.organization_id=v_actor.organization_id and es.active=true and lower(coalesce(au.email,''))=v_email) then raise exception 'A staff member with this email is already active'; end if;
  update public.staff_invitations set role=p_role,can_kitchen=v_kitchen,can_waiter=v_waiter,expires_at=greatest(expires_at,now()+interval '7 days') where branch_id=v_branch.id and lower(email)=v_email and accepted_at is null and expires_at>now();
  select * into v_row from public.staff_invitations si where si.branch_id=v_branch.id and lower(si.email)=v_email and si.accepted_at is null and si.expires_at>now() order by si.created_at desc limit 1;
  v_token:=encode(extensions.gen_random_bytes(24),'hex');
  if v_row.id is not null then
    update public.staff_invitations set token_hash=encode(extensions.digest(v_token,'sha256'),'hex'),role=p_role,can_kitchen=v_kitchen,can_waiter=v_waiter returning * into v_row;
  else
    insert into public.staff_invitations(organization_id,branch_id,email,role,can_kitchen,can_waiter,token_hash,created_by) values(v_actor.organization_id,v_branch.id,v_email,p_role,v_kitchen,v_waiter,encode(extensions.digest(v_token,'sha256'),'hex'),auth.uid()) returning * into v_row;
  end if;
  return jsonb_build_object('id',v_row.id,'email',v_row.email,'role',v_row.role,'can_kitchen',v_row.can_kitchen,'can_waiter',v_row.can_waiter,'expires_at',v_row.expires_at,'token',v_token);
end;
$$;
grant execute on function public.create_staff_invitation(uuid,text,public.staff_role,boolean,boolean) to authenticated;

drop function if exists public.claim_staff_invitation(text,text);
create or replace function public.claim_staff_invitation(p_token text,p_display_name text default null)
returns public.staff language plpgsql security definer set search_path=public,extensions as $$
declare v_inv public.staff_invitations%rowtype; v_hash text:=encode(extensions.digest(trim(coalesce(p_token,'')),'sha256'),'hex'); v_user uuid:=auth.uid(); v_email text; v_staff public.staff%rowtype;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select * into v_inv from public.staff_invitations where token_hash=v_hash for update;
  if v_inv.id is null or v_inv.accepted_at is not null or v_inv.expires_at<=now() then raise exception 'Invitation link is invalid or expired'; end if;
  select lower(coalesce(email,'')) into v_email from auth.users where id=v_user;
  if v_email is null or v_email<>lower(v_inv.email) then raise exception 'Sign in with the invited email address' using errcode='42501'; end if;
  insert into public.staff(user_id,organization_id,branch_id,role,active,display_name,can_kitchen,can_waiter)
  values(v_user,v_inv.organization_id,v_inv.branch_id,v_inv.role,true,nullif(left(trim(coalesce(p_display_name,'')),120),''),v_inv.can_kitchen,v_inv.can_waiter)
  on conflict (user_id,organization_id,branch_id) do update set role=excluded.role,active=true,display_name=coalesce(excluded.display_name,public.staff.display_name),can_kitchen=excluded.can_kitchen,can_waiter=excluded.can_waiter,updated_at=now()
  returning * into v_staff;
  update public.staff_invitations set accepted_at=now() where id=v_inv.id;
  return v_staff;
end;
$$;
grant execute on function public.claim_staff_invitation(text,text) to authenticated;

create or replace function public.set_staff_capabilities(p_staff_id uuid,p_can_kitchen boolean,p_can_waiter boolean)
returns public.staff language plpgsql security definer set search_path=public as $$
declare v_staff public.staff%rowtype; v_actor public.staff%rowtype; v_user uuid:=auth.uid(); v_role public.staff_role;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  if not (p_can_kitchen or p_can_waiter) then raise exception 'At least one operational permission is required'; end if;
  select * into v_staff from public.staff where id=p_staff_id for update;
  select * into v_actor from public.staff where user_id=v_user and organization_id=v_staff.organization_id and active=true order by created_at limit 1;
  if v_staff.id is null or v_actor.id is null or v_actor.role<>'OWNER' then raise exception 'Only the owner can change staff permissions' using errcode='42501'; end if;
  if v_staff.role='OWNER' then raise exception 'Owner permissions cannot be changed'; end if;
  v_role:=case when p_can_kitchen and not p_can_waiter then 'KITCHEN'::public.staff_role when p_can_waiter and not p_can_kitchen then 'WAITER'::public.staff_role else 'KITCHEN'::public.staff_role end;
  update public.staff set role=v_role,can_kitchen=p_can_kitchen,can_waiter=p_can_waiter,updated_at=now() where id=p_staff_id returning * into v_staff;
  return v_staff;
end;
$$;
grant execute on function public.set_staff_capabilities(uuid,boolean,boolean) to authenticated;

-- Status transitions now honor independent Kitchen/Waiter capabilities.
create or replace function public.transition_order_status(p_order_id uuid,p_new_status public.order_status)
returns table(id uuid,order_number bigint,table_id uuid,branch_id uuid,status public.order_status,payment_status public.payment_status,payment_method text,subtotal numeric,tax numeric,discount numeric,total numeric,created_at timestamptz,updated_at timestamptz)
language plpgsql security definer set search_path=public as $$
declare v_order public.orders%rowtype; v_staff public.staff%rowtype; v_user uuid:=auth.uid(); v_allowed boolean:=false;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select o.* into v_order from public.orders o where o.id=p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  select s.* into v_staff from public.staff s where s.user_id=v_user and s.branch_id=v_order.branch_id and s.active=true order by case when s.role='OWNER' then 0 when s.role='MANAGER' then 1 else 2 end,s.created_at limit 1;
  if v_staff.id is null then raise exception 'You do not have access to this order' using errcode='42501'; end if;
  if v_order.status='NEW' and p_new_status='ACCEPTED' and v_staff.role in ('OWNER','MANAGER') then v_allowed:=true;
  elsif v_order.status='ACCEPTED' and p_new_status='PREPARING' and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_kitchen) then v_allowed:=true;
  elsif v_order.status='PREPARING' and p_new_status='READY' and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_kitchen) then v_allowed:=true;
  elsif v_order.status='READY' and p_new_status='SERVED' and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter) then v_allowed:=true;
  elsif v_order.status='SERVED' and p_new_status='COMPLETED' and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter) then v_allowed:=true;
  end if;
  if not v_allowed then raise exception 'Invalid or unauthorized order status transition: % → %',v_order.status,p_new_status using errcode='42501'; end if;
  update public.orders ord set status=p_new_status,updated_at=now() where ord.id=v_order.id;
  insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id) values(v_order.id,v_order.branch_id,'STATUS_CHANGED',v_order.status::text,p_new_status::text,v_user);
  return query select ord.id,ord.order_number,ord.table_id,ord.branch_id,ord.status,ord.payment_status,ord.payment_method,ord.subtotal,ord.tax,ord.discount,ord.total,ord.created_at,ord.updated_at from public.orders ord where ord.id=v_order.id;
end;
$$;
grant execute on function public.transition_order_status(uuid,public.order_status) to authenticated;

-- Notification fan-out uses capabilities for dual-access staff.
create or replace function public.notify_order_status_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_table integer; v_order bigint; v_msg text;
begin
  select t.table_number into v_table from public.tables t where t.id=NEW.table_id; v_order:=NEW.order_number;
  if TG_OP='INSERT' then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_NEW','New order',format('Order #%s received from Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—')),'ORDER',NEW.id,'{}'::jsonb,null);
    return NEW;
  end if;
  if NEW.status::text=OLD.status::text and NEW.payment_status::text=OLD.payment_status::text then return NEW; end if;
  if NEW.status::text='ACCEPTED' then
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'ORDER_ACCEPTED','Start preparing',format('Order #%s accepted. Start preparing Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','ACCEPTED') from public.staff s where s.branch_id=NEW.branch_id and s.active and s.can_kitchen;
  elsif NEW.status::text='READY' then
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'ORDER_READY','Order ready',format('Order #%s is ready at Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','READY') from public.staff s where s.branch_id=NEW.branch_id and s.active and (s.can_waiter or s.role in ('OWNER','MANAGER'));
  elsif NEW.status::text='SERVED' then perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_SERVED','Order served',format('Order #%s was served at Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','SERVED'),null);
  elsif NEW.status::text='COMPLETED' then perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_COMPLETED','Order completed',format('Order #%s is completed.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','COMPLETED'),null);
  elsif NEW.status::text='CANCELLED' then
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'ORDER_CANCELLED','Order cancelled',format('Order #%s was cancelled.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','CANCELLED') from public.staff s where s.branch_id=NEW.branch_id and s.active;
  end if;
  if NEW.payment_status::text<>OLD.payment_status::text and NEW.payment_status::text='PAID' then
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'PAYMENT_PAID','Payment received',format('Order #%s is marked paid.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('payment_status','PAID') from public.staff s where s.branch_id=NEW.branch_id and s.active and (s.can_waiter or s.role in ('OWNER','MANAGER'));
  end if;
  return NEW;
end;
$$;

drop trigger if exists orders_notification_fanout on public.orders;
create trigger orders_notification_fanout after insert or update of status,payment_status on public.orders for each row execute function public.notify_order_status_change();

notify pgrst,'reload schema';

-- Service requests honor the independent Waiter capability.
create or replace function public.resolve_service_request(p_request_id uuid,p_status text default 'RESOLVED')
returns public.service_requests
language plpgsql
security definer
set search_path=public
as $$
declare v_req public.service_requests%rowtype; v_staff public.staff%rowtype; v_user uuid:=auth.uid(); v_new text:=upper(trim(coalesce(p_status,'RESOLVED')));
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select r.* into v_req from public.service_requests r where r.id=p_request_id for update;
  if v_req.id is null then raise exception 'Service request not found'; end if;
  select s.* into v_staff from public.staff s where s.user_id=v_user and s.branch_id=v_req.branch_id and s.active=true order by case when s.role='OWNER' then 0 when s.role='MANAGER' then 1 else 2 end,s.created_at limit 1;
  if v_staff.id is null or not (v_staff.can_waiter or v_staff.role in ('OWNER','MANAGER')) then raise exception 'Not authorized' using errcode='42501'; end if;
  if v_new not in ('ACKNOWLEDGED','RESOLVED','CANCELLED') then raise exception 'Invalid service request status'; end if;
  update public.service_requests set status=v_new,resolved_by=case when v_new='RESOLVED' then v_user else resolved_by end,resolved_at=case when v_new='RESOLVED' then now() else resolved_at end where id=p_request_id;
  select * into v_req from public.service_requests where id=p_request_id;
  return v_req;
end;
$$;
grant execute on function public.resolve_service_request(uuid,text) to authenticated;

-- Cancellation decisions honor the Waiter capability only for resolving/deciding requests as existing product behavior allows.
create or replace function public.decide_order_cancellation(p_request_id uuid,p_accept boolean)
returns public.order_cancellation_requests language plpgsql security definer set search_path=public as $$
declare v_req public.order_cancellation_requests%rowtype; v_order public.orders%rowtype; v_staff public.staff%rowtype; v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select * into v_req from public.order_cancellation_requests where id=p_request_id for update;
  if v_req.id is null then raise exception 'Cancellation request not found'; end if;
  if v_req.status<>'PENDING' then raise exception 'Cancellation request already decided'; end if;
  select * into v_order from public.orders where id=v_req.order_id for update;
  select * into v_staff from public.staff where user_id=v_user and branch_id=v_req.branch_id and active=true order by case when role='OWNER' then 0 when role='MANAGER' then 1 else 2 end,created_at limit 1;
  if v_staff.id is null or not (v_staff.can_waiter or v_staff.role in ('OWNER','MANAGER')) then raise exception 'Not authorized' using errcode='42501'; end if;
  if v_order.status::text not in ('NEW','ACCEPTED','PREPARING') then
    update public.order_cancellation_requests set status='REJECTED',decided_at=coalesce(decided_at,now()),decided_by=v_user where id=v_req.id returning * into v_req;
    update public.notifications set read_at=coalesce(read_at,now()) where entity_type='ORDER_CANCELLATION' and entity_id=v_req.id;
    insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata) values(v_order.id,v_order.branch_id,'CANCELLATION_AUTO_REJECTED',v_user,jsonb_build_object('request_id',v_req.id,'reason','Order was no longer cancellable'));
    return v_req;
  end if;
  update public.order_cancellation_requests set status=case when p_accept then 'ACCEPTED' else 'REJECTED' end,decided_at=now(),decided_by=v_user where id=v_req.id returning * into v_req;
  update public.notifications set read_at=coalesce(read_at,now()) where entity_type='ORDER_CANCELLATION' and entity_id=v_req.id;
  if p_accept then
    update public.orders set status='CANCELLED',updated_at=now() where id=v_order.id;
    insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id,metadata) values(v_order.id,v_order.branch_id,'CANCELLATION_ACCEPTED',v_order.status::text,'CANCELLED',v_user,jsonb_build_object('request_id',v_req.id,'reason',v_req.reason));
  else
    insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata) values(v_order.id,v_order.branch_id,'CANCELLATION_REJECTED',v_user,jsonb_build_object('request_id',v_req.id,'reason',v_req.reason));
  end if;
  return v_req;
end;
$$;
grant execute on function public.decide_order_cancellation(uuid,boolean) to authenticated;

-- Service/cancellation notification fan-out uses the capability fields so dual-access staff receive the right alerts.
create or replace function public.notify_service_request()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_table integer;
begin
  select t.table_number into v_table from public.tables t where t.id=NEW.table_id;
  if TG_OP='INSERT' and NEW.status='OPEN' then
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'SERVICE_REQUEST','Service request',format('Table %s requested %s.',coalesce(v_table::text,'—'),replace(lower(NEW.type),'_',' ')),'SERVICE_REQUEST',NEW.id,jsonb_build_object('type',NEW.type)
    from public.staff s where s.branch_id=NEW.branch_id and s.active=true and (s.can_waiter or s.role in ('OWNER','MANAGER'));
  elsif TG_OP='UPDATE' and OLD.status<>NEW.status and NEW.status in ('RESOLVED','CANCELLED') then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'SERVICE_RESOLVED','Service request resolved',format('Table %s service request was %s.',coalesce(v_table::text,'—'),lower(NEW.status)),'SERVICE_REQUEST',NEW.id,jsonb_build_object('status',NEW.status),NEW.resolved_by);
  end if;
  return NEW;
end;
$$;

drop trigger if exists service_request_notification_fanout on public.service_requests;
create trigger service_request_notification_fanout after insert or update of status on public.service_requests for each row execute function public.notify_service_request();

-- Cancellation requests should notify managers/owners and staff with Waiter capability.
create or replace function public.request_order_cancellation(p_order_id uuid,p_reason text default null)
returns public.order_cancellation_requests language plpgsql security definer set search_path=public as $$
declare v_order public.orders%rowtype; v_req public.order_cancellation_requests%rowtype;
begin
  select * into v_order from public.orders where id=p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if v_order.status::text not in ('NEW','ACCEPTED','PREPARING') then raise exception 'Cancellation is no longer available for this order'; end if;
  insert into public.order_cancellation_requests(order_id,branch_id,reason) values(v_order.id,v_order.branch_id,nullif(left(trim(coalesce(p_reason,'')),300),'')) returning * into v_req;
  insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
  select v_order.branch_id,s.id,'CANCELLATION_REQUEST','Cancellation requested',format('Order #%s has a cancellation request.',coalesce(v_order.order_number::text,'—')),'ORDER_CANCELLATION',v_req.id,jsonb_build_object('order_id',v_order.id)
  from public.staff s where s.branch_id=v_order.branch_id and s.active=true and (s.can_waiter or s.role in ('OWNER','MANAGER'));
  return v_req;
end;
$$;
grant execute on function public.request_order_cancellation(uuid,text) to anon,authenticated;

notify pgrst,'reload schema';
