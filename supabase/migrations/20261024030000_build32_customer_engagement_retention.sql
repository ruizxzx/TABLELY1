-- TABLELY Build 32: customer engagement, loyalty, feedback, translations and review operations.
begin;

create table if not exists public.restaurant_customer_preferences (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 customer_id uuid references public.customer_profiles(id) on delete cascade, phone text, email text,
 whatsapp_service boolean not null default false, whatsapp_marketing boolean not null default false,
 email_notifications boolean not null default false, feedback_messages boolean not null default false,
 language_code text not null default 'en', loyalty_enrolled boolean not null default false,
 consent_source text, consented_at timestamptz, withdrawn_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(customer_id is not null or phone is not null or email is not null),
 unique(organization_id,customer_id)
);
create index if not exists restaurant_customer_preferences_contact_idx on public.restaurant_customer_preferences(organization_id,phone,email);

create table if not exists public.restaurant_whatsapp_connections (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 business_account_id text not null, phone_number_id text not null, business_name text, display_phone text,
 access_token_encrypted text not null, token_expires_at timestamptz,
 status text not null default 'PENDING' check(status in ('PENDING','CONNECTED','REAUTH_REQUIRED','DISCONNECTED','ERROR')),
 webhook_status text not null default 'UNKNOWN', last_error_code text, last_error_at timestamptz,
 connected_by uuid references auth.users(id) on delete set null, connected_at timestamptz,
 settings jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(phone_number_id)
);

create table if not exists public.restaurant_notification_preferences (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 event_key text not null check(event_key in ('ORDER_RECEIVED','ORDER_CONFIRMED','ORDER_REJECTED','PREPARATION_STARTED','ORDER_READY','ORDER_COMPLETED','PAYMENT_CONFIRMED','RECEIPT_AVAILABLE','ORDER_CANCELLED')),
 enabled boolean not null default true, template_name text, template_language text not null default 'en',
 updated_by uuid references auth.users(id) on delete set null, updated_at timestamptz not null default now(),
 primary key(organization_id,event_key)
);
create table if not exists public.restaurant_notification_queue (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 branch_id uuid references public.branches(id) on delete set null, order_id uuid references public.orders(id) on delete set null,
 event_key text not null, channel text not null check(channel in ('WHATSAPP','EMAIL')),
 recipient_hash text not null, recipient_encrypted text, template_name text, template_language text,
 payload jsonb not null default '{}'::jsonb, status text not null default 'QUEUED' check(status in ('QUEUED','SENDING','SENT','DELIVERED','READ','FAILED','CANCELLED')),
 provider_message_id text, attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 error_code text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 idempotency_key text not null unique
);
create index if not exists restaurant_notification_queue_ready_idx on public.restaurant_notification_queue(status,next_attempt_at) where status in ('QUEUED','FAILED');
create table if not exists public.restaurant_notification_events (
 id uuid primary key default gen_random_uuid(), queue_id uuid references public.restaurant_notification_queue(id) on delete set null,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 provider_event_id text unique, provider_message_id text, event_type text not null, payload jsonb not null default '{}'::jsonb,
 received_at timestamptz not null default now()
);

create table if not exists public.restaurant_loyalty_programs (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 enabled boolean not null default false, points_per_currency numeric(8,4) not null default 1 check(points_per_currency between 0 and 100),
 currency_per_point numeric(8,4) not null default 0.01 check(currency_per_point between 0 and 100),
 minimum_redemption_points integer not null default 100 check(minimum_redemption_points>=0),
 points_expire_days integer check(points_expire_days is null or points_expire_days between 1 and 3650),
 eligible_payment_statuses text[] not null default array['PAID'], updated_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now()
);
create table if not exists public.restaurant_loyalty_ledger (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 branch_id uuid references public.branches(id) on delete set null, customer_id uuid not null references public.customer_profiles(id) on delete restrict,
 order_id uuid references public.orders(id) on delete set null, event_key text not null,
 entry_type text not null check(entry_type in ('EARN','REDEEM','REFUND_REVERSAL','EXPIRY','ADJUSTMENT')),
 points integer not null check(points<>0), amount numeric(12,2), expires_at timestamptz, reverses_entry_id uuid references public.restaurant_loyalty_ledger(id) on delete restrict,
 created_at timestamptz not null default now(), unique(organization_id,event_key)
);
create index if not exists restaurant_loyalty_balance_idx on public.restaurant_loyalty_ledger(organization_id,customer_id,created_at desc);
create table if not exists public.restaurant_loyalty_redemptions (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 branch_id uuid references public.branches(id) on delete set null, customer_id uuid not null references public.customer_profiles(id) on delete restrict,
 order_id uuid not null references public.orders(id) on delete restrict, points integer not null check(points>0), discount_amount numeric(12,2) not null check(discount_amount>0),
 status text not null default 'APPLIED' check(status in ('RESERVED','APPLIED','REVERSED','CANCELLED')),
 idempotency_key text not null unique, created_at timestamptz not null default now()
);

create table if not exists public.restaurant_feedback_settings (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 enabled boolean not null default false, delay_minutes integer not null default 30 check(delay_minutes between 0 and 10080),
 channel text not null default 'IN_APP' check(channel in ('IN_APP','WHATSAPP')),
 questions jsonb not null default '[{"key":"rating","type":"rating","required":true},{"key":"comment","type":"text","required":false}]'::jsonb,
 updated_by uuid references auth.users(id) on delete set null, updated_at timestamptz not null default now()
);
create table if not exists public.restaurant_feedback_invitations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 branch_id uuid references public.branches(id) on delete set null, order_id uuid not null references public.orders(id) on delete cascade,
 customer_id uuid references public.customer_profiles(id) on delete set null, status text not null default 'QUEUED' check(status in ('QUEUED','SENT','DELIVERED','CLICKED','SUBMITTED','FAILED','CANCELLED')),
 channel text not null default 'IN_APP', token_hash text not null unique default encode(digest(gen_random_bytes(32),'sha256'),'hex'), sent_at timestamptz, clicked_at timestamptz, created_at timestamptz not null default now(), unique(order_id)
);
create table if not exists public.restaurant_customer_feedback (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 branch_id uuid references public.branches(id) on delete set null, order_id uuid references public.orders(id) on delete set null,
 customer_id uuid references public.customer_profiles(id) on delete set null, invitation_id uuid unique references public.restaurant_feedback_invitations(id) on delete set null,
 rating integer not null check(rating between 1 and 5), comment text check(comment is null or length(comment)<=5000), answers jsonb not null default '{}'::jsonb,
 is_private boolean not null default true, status text not null default 'NEW' check(status in ('NEW','IN_PROGRESS','RESOLVED','ARCHIVED')),
 assigned_to uuid references auth.users(id) on delete set null, resolution_note text, created_at timestamptz not null default now(), resolved_at timestamptz
);
create index if not exists restaurant_customer_feedback_org_date_idx on public.restaurant_customer_feedback(organization_id,created_at desc);

-- Existing Build 16 translation tables are extended with review state and locale settings.
alter table public.menu_item_translations add column if not exists review_status text not null default 'APPROVED' check(review_status in ('DRAFT','NEEDS_REVIEW','APPROVED'));
alter table public.menu_category_translations add column if not exists review_status text not null default 'APPROVED' check(review_status in ('DRAFT','NEEDS_REVIEW','APPROVED'));
create table if not exists public.restaurant_language_settings (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 default_language text not null default 'en', enabled_languages text[] not null default array['en'],
 auto_translate boolean not null default false, updated_by uuid references auth.users(id) on delete set null, updated_at timestamptz not null default now()
);

create table if not exists public.restaurant_google_connections (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 google_account_id text, refresh_token_encrypted text, access_token_encrypted text, token_expires_at timestamptz,
 status text not null default 'DISCONNECTED' check(status in ('DISCONNECTED','CONNECTED','REAUTH_REQUIRED','ERROR')),
 connected_by uuid references auth.users(id) on delete set null, connected_at timestamptz,
 last_sync_at timestamptz, last_sync_status text, last_sync_error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.restaurant_google_locations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 branch_id uuid not null references public.branches(id) on delete cascade, google_location_name text not null, display_name text,
 verified boolean not null default false, created_at timestamptz not null default now(), unique(branch_id), unique(google_location_name)
);
create table if not exists public.restaurant_google_review_settings (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 branch_id uuid not null references public.branches(id) on delete cascade,
 review_url text, invitation_enabled boolean not null default false,
 invite_channel text not null default 'QR' check(invite_channel in ('WHATSAPP','QR')),
 updated_by uuid references auth.users(id) on delete set null, updated_at timestamptz not null default now(), primary key(branch_id)
);
create table if not exists public.restaurant_google_reviews (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 branch_id uuid not null references public.branches(id) on delete cascade, google_review_id text not null,
 star_rating integer check(star_rating between 1 and 5), review_text text, reviewer_name text, review_created_at timestamptz,
 owner_reply text, owner_reply_updated_at timestamptz, reply_status text not null default 'NONE' check(reply_status in ('NONE','DRAFT','PENDING','PUBLISHED','FAILED')),
 synced_at timestamptz not null default now(), unique(organization_id,google_review_id)
);
create table if not exists public.restaurant_review_invitations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 branch_id uuid references public.branches(id) on delete set null, order_id uuid not null references public.orders(id) on delete cascade,
 customer_id uuid references public.customer_profiles(id) on delete set null, channel text not null check(channel in ('WHATSAPP','EMAIL','QR')),
 status text not null default 'QUEUED' check(status in ('QUEUED','SENT','DELIVERED','CLICKED','FAILED','CANCELLED')),
 clicked_at timestamptz, created_at timestamptz not null default now(), unique(order_id)
);
create table if not exists public.restaurant_engagement_audit (
 id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id) on delete cascade,
 actor_user_id uuid references auth.users(id) on delete set null, action text not null, entity_type text not null, entity_id uuid,
 details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);

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
  if found then
   v_points:=floor(greatest(new.total,0)*v_program.points_per_currency)::integer;
   if v_points>0 then
    insert into public.restaurant_loyalty_ledger(organization_id,branch_id,customer_id,order_id,event_key,entry_type,points,amount,expires_at)
    values(v_org,new.branch_id,v_customer,new.id,'order:'||new.id::text||':earn','EARN',v_points,new.total,
      case when v_program.points_expire_days is null then null else now()+make_interval(days=>v_program.points_expire_days) end)
    on conflict(organization_id,event_key) do nothing;
   end if;
   insert into public.restaurant_customer_preferences(organization_id,customer_id,phone,loyalty_enrolled)
   values(v_org,v_customer,v_phone,true) on conflict(organization_id,customer_id) do update set loyalty_enrolled=true,updated_at=now();
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
drop trigger if exists tablely_build32_order_engagement_trigger on public.orders;
create trigger tablely_build32_order_engagement_trigger after insert or update on public.orders
for each row execute function public.tablely_build32_order_engagement();
revoke execute on function public.tablely_build32_order_engagement() from public,anon,authenticated;

do $$ declare t text; begin
 foreach t in array array['restaurant_customer_preferences','restaurant_whatsapp_connections','restaurant_notification_preferences','restaurant_notification_queue','restaurant_notification_events','restaurant_loyalty_programs','restaurant_loyalty_ledger','restaurant_loyalty_redemptions','restaurant_feedback_settings','restaurant_feedback_invitations','restaurant_customer_feedback','restaurant_language_settings','restaurant_google_connections','restaurant_google_locations','restaurant_google_review_settings','restaurant_google_reviews','restaurant_review_invitations','restaurant_engagement_audit'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated,public',t);
 end loop;
end $$;

-- Server-side routes use the service role only after resolving the user's tenant membership.
-- No direct browser access to encrypted provider credentials, ledgers, or private feedback.
commit;
