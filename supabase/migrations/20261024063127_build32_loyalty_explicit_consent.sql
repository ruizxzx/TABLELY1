-- Record opt-in and withdrawal events and require active consent for earning.
begin;

alter table public.restaurant_customer_preferences
  add column if not exists loyalty_consent_at timestamptz,
  add column if not exists loyalty_consent_withdrawn_at timestamptz,
  add column if not exists loyalty_consent_source text,
  add column if not exists loyalty_consent_version text;

create table if not exists public.restaurant_loyalty_consent_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null references public.customer_profiles(id) on delete cascade,
  event_type text not null check(event_type in ('ENROLLED','WITHDRAWN')),
  consent_source text not null,
  consent_version text not null,
  created_at timestamptz not null default now()
);
create index if not exists restaurant_loyalty_consent_events_customer_idx
  on public.restaurant_loyalty_consent_events(organization_id,customer_id,created_at desc);

alter table public.restaurant_loyalty_consent_events enable row level security;
revoke all on public.restaurant_loyalty_consent_events from anon,authenticated,public;
grant select,insert on public.restaurant_loyalty_consent_events to service_role;

create or replace function public.set_restaurant_loyalty_consent(
  p_auth_user_id uuid,
  p_organization_id uuid,
  p_enrolled boolean
)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  v_customer_id uuid;
  v_now timestamptz:=now();
  v_source text:='CUSTOMER_LOYALTY_PAGE';
  v_version text:='loyalty-v1';
begin
  if p_auth_user_id is null or p_organization_id is null or p_enrolled is null then
    raise exception 'Customer and loyalty selection are required';
  end if;

  select id into v_customer_id
  from public.customer_profiles
  where auth_user_id=p_auth_user_id;
  if v_customer_id is null then
    raise exception 'Customer profile not found';
  end if;

  if not exists(
    select 1 from public.organizations
    where id=p_organization_id and status='ACTIVE'::public.account_status
  ) then
    raise exception 'Restaurant is unavailable';
  end if;

  if p_enrolled and not exists(
    select 1 from public.restaurant_loyalty_programs
    where organization_id=p_organization_id and enabled
  ) then
    raise exception 'Loyalty program is not active';
  end if;

  insert into public.restaurant_customer_preferences(
    organization_id,customer_id,loyalty_enrolled,loyalty_consent_at,
    loyalty_consent_withdrawn_at,loyalty_consent_source,loyalty_consent_version
  )
  values(
    p_organization_id,v_customer_id,p_enrolled,
    case when p_enrolled then v_now else null end,
    case when p_enrolled then null else v_now end,
    case when p_enrolled then v_source else null end,
    case when p_enrolled then v_version else null end
  )
  on conflict(organization_id,customer_id) do update set
    loyalty_enrolled=excluded.loyalty_enrolled,
    loyalty_consent_at=case when p_enrolled then v_now else public.restaurant_customer_preferences.loyalty_consent_at end,
    loyalty_consent_withdrawn_at=case when p_enrolled then null else v_now end,
    loyalty_consent_source=case when p_enrolled then v_source else public.restaurant_customer_preferences.loyalty_consent_source end,
    loyalty_consent_version=case when p_enrolled then v_version else public.restaurant_customer_preferences.loyalty_consent_version end,
    updated_at=v_now;

  insert into public.restaurant_loyalty_consent_events(
    organization_id,customer_id,event_type,consent_source,consent_version,created_at
  )
  values(
    p_organization_id,v_customer_id,
    case when p_enrolled then 'ENROLLED' else 'WITHDRAWN' end,
    v_source,v_version,v_now
  );
end;
$$;

revoke all on function public.set_restaurant_loyalty_consent(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.set_restaurant_loyalty_consent(uuid,uuid,boolean) to service_role;

create or replace function public.tablely_build32_order_engagement()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_customer uuid; v_phone text; v_name text; v_event text; v_program public.restaurant_loyalty_programs%rowtype; v_points integer;
begin
 select b.organization_id into v_org from public.branches b where b.id=new.branch_id;
 v_customer:=new.customer_profile_id;
 v_phone:=nullif(right(regexp_replace(coalesce(new.customer_phone,''),'[^0-9]','','g'),10),'');
 v_name:=coalesce(nullif(new.customer_name,''),'Customer');
 if v_org is null then return new; end if;

 if new.payment_status::text='PAID' and new.status::text in ('SERVED','COMPLETED') and v_customer is not null then
  select * into v_program from public.restaurant_loyalty_programs where organization_id=v_org and enabled;
  if found and exists(
    select 1 from public.restaurant_customer_preferences p
    where p.organization_id=v_org and p.customer_id=v_customer
      and p.loyalty_enrolled and p.loyalty_consent_at is not null
      and p.loyalty_consent_withdrawn_at is null
  ) then
   v_points:=floor(greatest(new.total,0)*v_program.points_per_currency)::integer;
   if v_points>0 then
    insert into public.restaurant_loyalty_ledger(organization_id,branch_id,customer_id,order_id,event_key,entry_type,points,amount,expires_at)
    values(v_org,new.branch_id,v_customer,new.id,'order:'||new.id::text||':earn','EARN',v_points,new.total,
      case when v_program.points_expire_days is null then null else now()+make_interval(days=>v_program.points_expire_days) end)
    on conflict(organization_id,event_key) do nothing;
   end if;
  end if;
 end if;

 if new.payment_status::text='REFUNDED' and (tg_op='INSERT' or old.payment_status::text is distinct from 'REFUNDED') then
  insert into public.restaurant_loyalty_ledger(organization_id,branch_id,customer_id,order_id,event_key,entry_type,points,amount)
  select v_org,new.branch_id,l.customer_id,new.id,'order:'||new.id::text||':refund-reversal','REFUND_REVERSAL',-l.points,-coalesce(new.total,0)
  from public.restaurant_loyalty_ledger l where l.organization_id=v_org and l.order_id=new.id and l.entry_type='EARN'
  on conflict(organization_id,event_key) do nothing;
 end if;

 if tg_op='INSERT' or new.status::text is distinct from old.status::text then
  v_event:=case new.status::text when 'NEW' then 'ORDER_RECEIVED' when 'ACCEPTED' then 'ORDER_CONFIRMED' when 'PREPARING' then 'PREPARATION_STARTED' when 'READY' then 'ORDER_READY' when 'SERVED' then 'ORDER_COMPLETED' when 'COMPLETED' then 'ORDER_COMPLETED' when 'CANCELLED' then 'ORDER_CANCELLED' when 'REJECTED' then 'ORDER_REJECTED' else null end;
  if v_event is not null and v_phone is not null and exists(select 1 from public.restaurant_whatsapp_connections c where c.organization_id=v_org and c.status='CONNECTED')
     and exists(select 1 from public.restaurant_customer_preferences p where p.organization_id=v_org and p.phone=v_phone and p.whatsapp_service and p.withdrawn_at is null)
     and coalesce((select np.enabled from public.restaurant_notification_preferences np where np.organization_id=v_org and np.event_key=v_event),true) then
   insert into public.restaurant_notification_queue(organization_id,branch_id,order_id,event_key,channel,recipient_hash,payload,idempotency_key)
   values(v_org,new.branch_id,new.id,v_event,'WHATSAPP',encode(digest(v_org::text||':'||v_phone,'sha256'),'hex'),jsonb_build_object('restaurantName',(select name from public.organizations where id=v_org),'customerName',v_name,'orderNumber',new.order_number,'orderAmount',new.total,'orderStatus',new.status::text),'order:'||new.id::text||':'||v_event)
   on conflict(idempotency_key) do nothing;
  end if;
 end if;

 if new.payment_status::text='PAID' and (tg_op='INSERT' or old.payment_status::text is distinct from 'PAID') and v_phone is not null
    and exists(select 1 from public.restaurant_whatsapp_connections c where c.organization_id=v_org and c.status='CONNECTED')
    and exists(select 1 from public.restaurant_customer_preferences p where p.organization_id=v_org and p.phone=v_phone and p.whatsapp_service and p.withdrawn_at is null)
    and coalesce((select np.enabled from public.restaurant_notification_preferences np where np.organization_id=v_org and np.event_key='PAYMENT_CONFIRMED'),true) then
  insert into public.restaurant_notification_queue(organization_id,branch_id,order_id,event_key,channel,recipient_hash,payload,idempotency_key)
  values(v_org,new.branch_id,new.id,'PAYMENT_CONFIRMED','WHATSAPP',encode(digest(v_org::text||':'||v_phone,'sha256'),'hex'),jsonb_build_object('restaurantName',(select name from public.organizations where id=v_org),'customerName',v_name,'orderNumber',new.order_number,'orderAmount',new.total,'orderStatus','PAID'),'order:'||new.id::text||':PAYMENT_CONFIRMED')
  on conflict(idempotency_key) do nothing;
 end if;

 if new.status::text='COMPLETED' and new.payment_status::text='PAID' and (tg_op='INSERT' or old.status::text is distinct from 'COMPLETED') then
  insert into public.restaurant_feedback_invitations(organization_id,branch_id,order_id,customer_id,channel,status)
  select v_org,new.branch_id,new.id,v_customer,s.channel,'QUEUED'
  from public.restaurant_feedback_settings s where s.organization_id=v_org and s.enabled
  on conflict(order_id) do nothing;
  if exists(select 1 from public.restaurant_feedback_invitations i where i.order_id=new.id and i.channel='WHATSAPP') and v_phone is not null
     and exists(select 1 from public.restaurant_whatsapp_connections c where c.organization_id=v_org and c.status='CONNECTED')
     and exists(select 1 from public.restaurant_customer_preferences p where p.organization_id=v_org and p.phone=v_phone and p.feedback_messages and p.withdrawn_at is null) then
   insert into public.restaurant_notification_queue(organization_id,branch_id,order_id,event_key,channel,recipient_hash,payload,idempotency_key,next_attempt_at)
   select v_org,new.branch_id,new.id,'FEEDBACK_REQUEST','WHATSAPP',encode(digest(v_org::text||':'||v_phone,'sha256'),'hex'),
    jsonb_build_object('customerName',v_name,'feedbackUrl',coalesce(current_setting('app.site_url',true),'')||'/feedback/'||i.id::text),'order:'||new.id::text||':FEEDBACK_REQUEST'
    ,now()+make_interval(mins=>coalesce((select delay_minutes from public.restaurant_feedback_settings where organization_id=v_org),0))
   from public.restaurant_feedback_invitations i where i.order_id=new.id on conflict(idempotency_key) do nothing;
  end if;
  if exists(select 1 from public.restaurant_google_review_settings s where s.organization_id=v_org and s.branch_id=new.branch_id and s.invitation_enabled and s.review_url is not null) then
   insert into public.restaurant_review_invitations(organization_id,branch_id,order_id,customer_id,channel,status)
   select v_org,new.branch_id,new.id,v_customer,s.invite_channel,'QUEUED' from public.restaurant_google_review_settings s
   where s.organization_id=v_org and s.branch_id=new.branch_id and s.invitation_enabled and s.review_url is not null
   on conflict(order_id) do nothing;
   if exists(select 1 from public.restaurant_review_invitations i where i.order_id=new.id and i.channel='WHATSAPP') and v_phone is not null
      and exists(select 1 from public.restaurant_whatsapp_connections c where c.organization_id=v_org and c.status='CONNECTED')
      and exists(select 1 from public.restaurant_customer_preferences p where p.organization_id=v_org and p.phone=v_phone and p.feedback_messages and p.withdrawn_at is null) then
    insert into public.restaurant_notification_queue(organization_id,branch_id,order_id,event_key,channel,recipient_hash,payload,idempotency_key)
    select v_org,new.branch_id,new.id,'GOOGLE_REVIEW_INVITATION','WHATSAPP',encode(digest(v_org::text||':'||v_phone,'sha256'),'hex'),
     jsonb_build_object('customerName',v_name,'reviewUrl',coalesce(current_setting('app.site_url',true),'')||'/api/public-review-invitations/'||i.id::text),'order:'||new.id::text||':GOOGLE_REVIEW_INVITATION'
    from public.restaurant_review_invitations i where i.order_id=new.id on conflict(idempotency_key) do nothing;
   end if;
  end if;
 end if;
 return new;
end $$;

notify pgrst, 'reload schema';
commit;
