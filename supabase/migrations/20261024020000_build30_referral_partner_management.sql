-- TABLELY Build 30: referral attribution, verification, commission ledger and manual payouts.
begin;
create table if not exists public.tablely_partners (
 id uuid primary key default gen_random_uuid(), user_id uuid not null unique references auth.users(id) on delete cascade,
 partner_code text not null unique default ('TL-'||upper(encode(gen_random_bytes(5),'hex'))),
 full_name text not null check(length(trim(full_name)) between 2 and 120), email text not null, phone text not null,
 city text not null, state text not null, category text not null check(category in ('STUDENT','FREELANCER','AGENCY','CONSULTANT','OTHER')),
 company_name text, website_url text, referral_source text, address text, agreement_accepted_at timestamptz not null,
 status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED','SUSPENDED')),
 payout_details jsonb not null default '{}'::jsonb, payout_details_status text not null default 'NOT_PROVIDED' check(payout_details_status in ('NOT_PROVIDED','PENDING','VERIFIED','REJECTED')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.tablely_referral_clicks (
 id uuid primary key default gen_random_uuid(), tracking_id uuid not null unique default gen_random_uuid(),
 partner_id uuid not null references public.tablely_partners(id) on delete restrict, landing_path text not null default '/join',
 referrer_host text, campaign jsonb not null default '{}'::jsonb, ip_fingerprint text, user_agent text,
 clicked_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '30 days', claimed_at timestamptz
);
create index if not exists tablely_referral_clicks_partner_date_idx on public.tablely_referral_clicks(partner_id,clicked_at desc);
create table if not exists public.tablely_partner_referrals (
 id uuid primary key default gen_random_uuid(), partner_id uuid not null references public.tablely_partners(id) on delete restrict,
 restaurant_organization_id uuid unique references public.organizations(id) on delete set null,
 click_id uuid references public.tablely_referral_clicks(id) on delete set null,
 submitted_restaurant_name text, submitted_owner_name text, submitted_phone text, submitted_email text,
 submitted_address text, submitted_branch text, website_url text, google_business_url text, gstin text,
 status text not null default 'REGISTRATION_STARTED' check(status in ('REGISTRATION_STARTED','CONTACT_VERIFIED','BUSINESS_VERIFICATION_PENDING','VERIFIED','TRIAL_STARTED','SUBSCRIPTION_ACTIVE','COMMISSION_GENERATED','PAID','REJECTED','NEEDS_REVIEW')),
 verification_notes text, fraud_flags jsonb not null default '[]'::jsonb, locked_at timestamptz,
 registered_at timestamptz not null default now(), verified_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists tablely_partner_referrals_partner_date_idx on public.tablely_partner_referrals(partner_id,created_at desc);
create index if not exists tablely_partner_referrals_status_idx on public.tablely_partner_referrals(status,created_at desc);
create table if not exists public.tablely_partner_commission_rules (
 plan_id text primary key references public.saas_plans(id) on update cascade on delete restrict,
 percent numeric(5,2) not null default 0 check(percent between 0 and 100), commission_mode text not null default 'RECURRING' check(commission_mode in ('ONE_TIME','RECURRING')),
 commission_months integer check(commission_months is null or commission_months between 1 and 120),
 calculation_basis text not null default 'PAYMENT_AMOUNT' check(calculation_basis in ('PAYMENT_AMOUNT','PLAN_PRICE')),
 holding_days integer not null default 30 check(holding_days between 0 and 365), minimum_payout numeric(12,2) not null default 500 check(minimum_payout>=0),
 effective_at timestamptz not null default now(), updated_by uuid references auth.users(id) on delete set null, reason text, updated_at timestamptz not null default now()
);
insert into public.tablely_partner_commission_rules(plan_id,percent,reason) select id,case id when 'STARTER' then 10 when 'GROWTH' then 12 when 'PRO' then 15 else 0 end,'Build 30 starting rate; editable by admin' from public.saas_plans on conflict(plan_id) do nothing;
create table if not exists public.tablely_partner_commission_overrides (
 partner_id uuid not null references public.tablely_partners(id) on delete restrict, plan_id text not null references public.saas_plans(id) on update cascade on delete restrict,
 percent numeric(5,2) not null check(percent between 0 and 100), commission_mode text not null default 'RECURRING' check(commission_mode in ('ONE_TIME','RECURRING')),
 commission_months integer check(commission_months is null or commission_months between 1 and 120), active boolean not null default true,
 effective_at timestamptz not null default now(), updated_by uuid references auth.users(id) on delete set null, reason text not null, updated_at timestamptz not null default now(),
 primary key(partner_id,plan_id)
);
create table if not exists public.tablely_partner_commissions (
 id uuid primary key default gen_random_uuid(), partner_id uuid not null references public.tablely_partners(id) on delete restrict,
 referral_id uuid not null references public.tablely_partner_referrals(id) on delete restrict, organization_id uuid not null references public.organizations(id) on delete restrict,
 billing_event_id uuid not null unique references public.subscription_billing_events(id) on delete restrict, provider_payment_id text,
 plan_id_snapshot text not null, plan_name_snapshot text not null, payment_amount numeric(12,2) not null check(payment_amount>0),
 commission_basis text not null, commission_rate numeric(5,2) not null check(commission_rate between 0 and 100),
 commission_amount numeric(12,2) not null check(commission_amount>=0), currency text not null default 'INR',
 status text not null default 'PENDING' check(status in ('PENDING','APPROVED','PAYABLE','PAID','ON_HOLD','REJECTED','REVERSED')),
 eligible_at timestamptz not null, created_at timestamptz not null default now()
);
create index if not exists tablely_partner_commissions_partner_status_idx on public.tablely_partner_commissions(partner_id,status,created_at desc);
create table if not exists public.tablely_partner_payouts (
 id uuid primary key default gen_random_uuid(), partner_id uuid not null references public.tablely_partners(id) on delete restrict,
 amount numeric(12,2) not null check(amount>0), status text not null default 'APPROVED' check(status in ('APPROVED','PAID','CANCELLED')),
 payment_method text check(payment_method in ('UPI','BANK_TRANSFER','OTHER')), transaction_reference text, transaction_date timestamptz, proof_url text,
 approved_by uuid references auth.users(id) on delete set null, paid_by uuid references auth.users(id) on delete set null,
 approved_at timestamptz not null default now(), paid_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.tablely_partner_payout_items (
 payout_id uuid not null references public.tablely_partner_payouts(id) on delete restrict,
 commission_id uuid not null unique references public.tablely_partner_commissions(id) on delete restrict,
 amount numeric(12,2) not null check(amount>0), primary key(payout_id,commission_id)
);
create table if not exists public.tablely_partner_adjustments (
 id uuid primary key default gen_random_uuid(), partner_id uuid not null references public.tablely_partners(id) on delete restrict,
 commission_id uuid references public.tablely_partner_commissions(id) on delete restrict,
 billing_event_id uuid references public.subscription_billing_events(id) on delete restrict,
 amount numeric(12,2) not null check(amount<>0), reason text not null, actor_user_id uuid references auth.users(id) on delete set null, created_at timestamptz not null default now(), unique(billing_event_id,commission_id)
);
create table if not exists public.tablely_partner_audit (
 id uuid primary key default gen_random_uuid(), actor_user_id uuid references auth.users(id) on delete set null,
 partner_id uuid references public.tablely_partners(id) on delete set null, referral_id uuid references public.tablely_partner_referrals(id) on delete set null,
 payout_id uuid references public.tablely_partner_payouts(id) on delete set null, action text not null, details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists tablely_partner_audit_created_idx on public.tablely_partner_audit(created_at desc);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('tablely-partner-payout-proofs','tablely-partner-payout-proofs',false,8388608,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create unique index if not exists tablely_partners_email_uidx on public.tablely_partners(lower(email));
create unique index if not exists tablely_partners_phone_uidx on public.tablely_partners(phone);
do $$ declare t text; begin
 foreach t in array array['tablely_partners','tablely_referral_clicks','tablely_partner_referrals','tablely_partner_commission_rules','tablely_partner_commission_overrides','tablely_partner_commissions','tablely_partner_payouts','tablely_partner_payout_items','tablely_partner_adjustments','tablely_partner_audit'] loop
  execute format('alter table public.%I enable row level security',t); execute format('revoke all on public.%I from anon, authenticated, public',t);
 end loop;
end $$;
create or replace function public.tablely_partner_dashboard() returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_partner public.tablely_partners%rowtype; v_result jsonb;
begin
 select * into v_partner from public.tablely_partners where user_id=auth.uid();
 if v_partner.id is null then raise exception 'Partner account not found' using errcode='P0002'; end if;
 select jsonb_build_object('partner',to_jsonb(v_partner)-'payout_details','metrics',jsonb_build_object(
  'clicks',(select count(*) from public.tablely_referral_clicks where partner_id=v_partner.id),
  'referrals',(select count(*) from public.tablely_partner_referrals where partner_id=v_partner.id),
  'verified',(select count(*) from public.tablely_partner_referrals where partner_id=v_partner.id and status in ('VERIFIED','TRIAL_STARTED','SUBSCRIPTION_ACTIVE','COMMISSION_GENERATED','PAID')),
  'paying',(select count(distinct organization_id) from public.tablely_partner_commissions where partner_id=v_partner.id),
  'pending',(select coalesce(sum(commission_amount),0) from public.tablely_partner_commissions where partner_id=v_partner.id and status in ('PENDING','APPROVED','ON_HOLD')),
  'payable',(select coalesce(sum(commission_amount),0) from public.tablely_partner_commissions where partner_id=v_partner.id and status='PAYABLE'),
  'reversed',(select coalesce(sum(-amount),0) from public.tablely_partner_adjustments where partner_id=v_partner.id and amount<0),
  'paid',(select coalesce(sum(amount),0) from public.tablely_partner_payouts where partner_id=v_partner.id and status='PAID')),
  'referrals_list',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'restaurant',coalesce(o.name,r.submitted_restaurant_name,'Restaurant lead'),'status',r.status,'created_at',r.created_at) order by r.created_at desc),'[]'::jsonb) from (select * from public.tablely_partner_referrals where partner_id=v_partner.id order by created_at desc limit 50) r left join public.organizations o on o.id=r.restaurant_organization_id),
  'commissions',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'plan',c.plan_name_snapshot,'amount',c.commission_amount,'rate',c.commission_rate,'status',c.status,'created_at',c.created_at) order by c.created_at desc),'[]'::jsonb) from (select * from public.tablely_partner_commissions where partner_id=v_partner.id order by created_at desc limit 100) c),
  'payouts',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount,'status',p.status,'method',p.payment_method,'reference',p.transaction_reference,'paid_at',p.paid_at) order by p.created_at desc),'[]'::jsonb) from (select * from public.tablely_partner_payouts where partner_id=v_partner.id order by created_at desc limit 50) p),
  'adjustments',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'amount',a.amount,'reason',a.reason,'created_at',a.created_at) order by a.created_at desc),'[]'::jsonb) from (select * from public.tablely_partner_adjustments where partner_id=v_partner.id order by created_at desc limit 100) a)
 ) into v_result; return v_result;
end $$;
revoke all on function public.tablely_partner_dashboard() from public,anon; grant execute on function public.tablely_partner_dashboard() to authenticated;
create or replace function public.tablely_partner_admin_set_status(p_partner_id uuid,p_status text) returns void language plpgsql security definer set search_path=public as $$
declare v_status text:=upper(trim(p_status)); begin
 if not public.is_platform_admin() then raise exception 'Platform admin required' using errcode='42501'; end if;
 if v_status not in ('APPROVED','REJECTED','SUSPENDED','PENDING') then raise exception 'Invalid status'; end if;
 update public.tablely_partners set status=v_status,updated_at=now() where id=p_partner_id;
 if not found then raise exception 'Partner not found'; end if;
 insert into public.tablely_partner_audit(actor_user_id,partner_id,action,details) values(auth.uid(),p_partner_id,'PARTNER_STATUS_CHANGED',jsonb_build_object('status',v_status));
end $$;
create or replace function public.tablely_partner_admin_verify_payout_details(p_partner_id uuid,p_status text) returns void language plpgsql security definer set search_path=public as $$
declare v_status text:=upper(trim(p_status)); begin
 if not public.is_platform_admin() then raise exception 'Platform admin required' using errcode='42501'; end if;
 if v_status not in ('VERIFIED','REJECTED','PENDING') then raise exception 'Invalid payout identity status'; end if;
 update public.tablely_partners set payout_details_status=v_status,updated_at=now() where id=p_partner_id and payout_details<>'{}'::jsonb;
 if not found then raise exception 'Partner payout details not found'; end if;
 insert into public.tablely_partner_audit(actor_user_id,partner_id,action,details) values(auth.uid(),p_partner_id,'PAYOUT_IDENTITY_STATUS_CHANGED',jsonb_build_object('status',v_status));
end $$;
create or replace function public.tablely_partner_admin_set_override(p_partner_id uuid,p_plan_id text,p_percent numeric,p_mode text,p_months integer,p_active boolean,p_reason text) returns void language plpgsql security definer set search_path=public as $$
declare v_old numeric; v_mode text:=upper(trim(p_mode)); begin
 if not public.is_platform_admin() then raise exception 'Platform admin required' using errcode='42501'; end if;
 if p_percent<0 or p_percent>100 or v_mode not in ('ONE_TIME','RECURRING') or length(trim(coalesce(p_reason,'')))<3 then raise exception 'Invalid partner override'; end if;
 select percent into v_old from public.tablely_partner_commission_overrides where partner_id=p_partner_id and plan_id=p_plan_id;
 insert into public.tablely_partner_commission_overrides(partner_id,plan_id,percent,commission_mode,commission_months,active,updated_by,reason,updated_at)
 values(p_partner_id,p_plan_id,p_percent,v_mode,p_months,p_active,auth.uid(),trim(p_reason),now())
 on conflict(partner_id,plan_id) do update set percent=excluded.percent,commission_mode=excluded.commission_mode,commission_months=excluded.commission_months,active=excluded.active,effective_at=now(),updated_by=excluded.updated_by,reason=excluded.reason,updated_at=now();
 insert into public.tablely_partner_audit(actor_user_id,partner_id,action,details) values(auth.uid(),p_partner_id,'PARTNER_COMMISSION_OVERRIDE_CHANGED',jsonb_build_object('plan_id',p_plan_id,'previous_rate',v_old,'new_rate',p_percent,'active',p_active,'reason',p_reason));
end $$;
create or replace function public.tablely_partner_set_payout_details_status(p_status text) returns void language plpgsql security definer set search_path=public as $$
declare v_status text:=upper(trim(p_status)); begin
 if auth.uid() is null or v_status not in ('PENDING','NOT_PROVIDED') then raise exception 'Invalid request' using errcode='42501'; end if;
 update public.tablely_partners set payout_details_status=v_status,updated_at=now() where user_id=auth.uid();
end $$;
create or replace function public.tablely_partner_admin_verify_referral(p_referral_id uuid,p_status text,p_note text default null) returns void language plpgsql security definer set search_path=public as $$
declare v_status text:=upper(trim(p_status)); v_partner uuid; begin
 if not public.is_platform_admin() then raise exception 'Platform admin required' using errcode='42501'; end if;
 if v_status not in ('VERIFIED','NEEDS_REVIEW','REJECTED','BUSINESS_VERIFICATION_PENDING') then raise exception 'Invalid verification status'; end if;
 update public.tablely_partner_referrals set status=v_status,verification_notes=nullif(trim(p_note),''),verified_at=case when v_status='VERIFIED' then now() else verified_at end,locked_at=coalesce(locked_at,now()),updated_at=now() where id=p_referral_id returning partner_id into v_partner;
 if v_partner is null then raise exception 'Referral not found'; end if;
 insert into public.tablely_partner_audit(actor_user_id,partner_id,referral_id,action,details) values(auth.uid(),v_partner,p_referral_id,'REFERRAL_VERIFICATION_CHANGED',jsonb_build_object('status',v_status,'note',p_note));
end $$;
create or replace function public.tablely_partner_admin_set_rule(p_plan_id text,p_percent numeric,p_mode text,p_months integer,p_basis text,p_holding_days integer,p_minimum numeric,p_reason text) returns void language plpgsql security definer set search_path=public as $$
declare v_old public.tablely_partner_commission_rules%rowtype; v_mode text:=upper(trim(p_mode)); v_basis text:=upper(trim(p_basis)); begin
 if not public.is_platform_admin() then raise exception 'Platform admin required' using errcode='42501'; end if;
 select * into v_old from public.tablely_partner_commission_rules where plan_id=p_plan_id for update;
 if p_percent<0 or p_percent>100 or v_mode not in ('ONE_TIME','RECURRING') or v_basis not in ('PAYMENT_AMOUNT','PLAN_PRICE') or p_holding_days<0 or p_holding_days>365 or p_minimum<0 then raise exception 'Invalid commission configuration'; end if;
 insert into public.tablely_partner_commission_rules(plan_id,percent,commission_mode,commission_months,calculation_basis,holding_days,minimum_payout,effective_at,updated_by,reason,updated_at)
 values(p_plan_id,p_percent,v_mode,p_months,v_basis,p_holding_days,p_minimum,now(),auth.uid(),nullif(trim(p_reason),''),now())
 on conflict(plan_id) do update set percent=excluded.percent,commission_mode=excluded.commission_mode,commission_months=excluded.commission_months,calculation_basis=excluded.calculation_basis,holding_days=excluded.holding_days,minimum_payout=excluded.minimum_payout,effective_at=excluded.effective_at,updated_by=excluded.updated_by,reason=excluded.reason,updated_at=now();
 insert into public.tablely_partner_audit(actor_user_id,action,details) values(auth.uid(),'COMMISSION_RULE_CHANGED',jsonb_build_object('plan_id',p_plan_id,'previous_rate',v_old.percent,'new_rate',p_percent,'reason',p_reason));
end $$;
create or replace function public.tablely_partner_admin_create_payout(p_partner_id uuid) returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_amount numeric(12,2); begin
 if not public.is_platform_admin() then raise exception 'Platform admin required' using errcode='42501'; end if;
 if not exists(select 1 from public.tablely_partners where id=p_partner_id and status='APPROVED' and payout_details_status='VERIFIED') then raise exception 'Approve the partner and verify payout identity before approving a payout'; end if;
 perform public.tablely_partner_release_commissions();
 perform 1 from public.tablely_partners where id=p_partner_id for update;
 if not found then raise exception 'Partner not found'; end if;
 select coalesce(sum(commission_amount),0) into v_amount from public.tablely_partner_commissions where partner_id=p_partner_id and status='PAYABLE';
 if v_amount<=0 then raise exception 'No payable commission balance'; end if;
 if v_amount<(select coalesce(max(r.minimum_payout),0) from public.tablely_partner_commissions c join public.tablely_partner_commission_rules r on r.plan_id=c.plan_id_snapshot where c.partner_id=p_partner_id and c.status='PAYABLE') then raise exception 'Payable balance is below the minimum payout threshold'; end if;
 insert into public.tablely_partner_payouts(partner_id,amount,status,approved_by) values(p_partner_id,v_amount,'APPROVED',auth.uid()) returning id into v_id;
 insert into public.tablely_partner_payout_items(payout_id,commission_id,amount) select v_id,id,commission_amount from public.tablely_partner_commissions where partner_id=p_partner_id and status='PAYABLE';
 update public.tablely_partner_commissions set status='APPROVED' where id in(select commission_id from public.tablely_partner_payout_items where payout_id=v_id);
 insert into public.tablely_partner_audit(actor_user_id,partner_id,payout_id,action,details) values(auth.uid(),p_partner_id,v_id,'PAYOUT_APPROVED',jsonb_build_object('amount',v_amount)); return v_id;
end $$;
create or replace function public.tablely_partner_admin_mark_paid(p_payout_id uuid,p_method text,p_reference text,p_date timestamptz,p_proof_url text default null) returns void language plpgsql security definer set search_path=public as $$
declare v_partner uuid; v_method text:=upper(trim(p_method)); begin
 if not public.is_platform_admin() then raise exception 'Platform admin required' using errcode='42501'; end if;
 if v_method not in ('UPI','BANK_TRANSFER','OTHER') or length(trim(coalesce(p_reference,'')))<4 then raise exception 'Payment method and transaction reference are required'; end if;
 update public.tablely_partner_payouts set status='PAID',payment_method=v_method,transaction_reference=trim(p_reference),transaction_date=coalesce(p_date,now()),proof_url=nullif(trim(p_proof_url),''),paid_by=auth.uid(),paid_at=now() where id=p_payout_id and status='APPROVED' returning partner_id into v_partner;
 if v_partner is null then raise exception 'Approved payout not found'; end if;
 update public.tablely_partner_commissions set status='PAID' where id in(select commission_id from public.tablely_partner_payout_items where payout_id=p_payout_id);
 insert into public.tablely_partner_audit(actor_user_id,partner_id,payout_id,action,details) values(auth.uid(),v_partner,p_payout_id,'PAYOUT_MARKED_PAID',jsonb_build_object('method',v_method,'reference',p_reference,'proof_url',p_proof_url));
end $$;
create or replace function public.tablely_partner_register(p_full_name text,p_city text,p_state text,p_category text,p_company text,p_website text,p_source text,p_address text) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_user auth.users%rowtype; v_partner public.tablely_partners%rowtype; v_category text:=upper(trim(p_category)); begin
 select * into v_user from auth.users where id=auth.uid();
 if v_user.id is null or v_user.email_confirmed_at is null or v_user.phone_confirmed_at is null then raise exception 'Verify your email and phone before applying' using errcode='42501'; end if;
 if length(trim(coalesce(p_full_name,'')))<2 or length(trim(coalesce(p_city,'')))<2 or length(trim(coalesce(p_state,'')))<2 or v_category not in ('STUDENT','FREELANCER','AGENCY','CONSULTANT','OTHER') then raise exception 'Complete all required partner details'; end if;
 insert into public.tablely_partners(user_id,full_name,email,phone,city,state,category,company_name,website_url,referral_source,address,agreement_accepted_at)
 values(v_user.id,trim(p_full_name),lower(v_user.email),v_user.phone,trim(p_city),trim(p_state),v_category,nullif(trim(p_company),''),nullif(trim(p_website),''),nullif(trim(p_source),''),nullif(trim(p_address),''),now()) returning * into v_partner;
 insert into public.tablely_partner_audit(actor_user_id,partner_id,action) values(auth.uid(),v_partner.id,'PARTNER_APPLIED');
 return jsonb_build_object('id',v_partner.id,'code',v_partner.partner_code,'status',v_partner.status);
end $$;
revoke all on function public.tablely_partner_register(text,text,text,text,text,text,text,text) from public,anon; grant execute on function public.tablely_partner_register(text,text,text,text,text,text,text,text) to authenticated;
revoke all on function public.tablely_partner_admin_set_status(uuid,text),public.tablely_partner_admin_verify_payout_details(uuid,text),public.tablely_partner_set_payout_details_status(text),public.tablely_partner_admin_set_override(uuid,text,numeric,text,integer,boolean,text),public.tablely_partner_admin_verify_referral(uuid,text,text),public.tablely_partner_admin_set_rule(text,numeric,text,integer,text,integer,numeric,text),public.tablely_partner_admin_create_payout(uuid),public.tablely_partner_admin_mark_paid(uuid,text,text,timestamptz,text) from public,anon;
grant execute on function public.tablely_partner_admin_set_status(uuid,text),public.tablely_partner_admin_verify_payout_details(uuid,text),public.tablely_partner_set_payout_details_status(text),public.tablely_partner_admin_set_override(uuid,text,numeric,text,integer,boolean,text),public.tablely_partner_admin_verify_referral(uuid,text,text),public.tablely_partner_admin_set_rule(text,numeric,text,integer,text,integer,numeric,text),public.tablely_partner_admin_create_payout(uuid),public.tablely_partner_admin_mark_paid(uuid,text,text,timestamptz,text) to authenticated;
create or replace function public.tablely_partner_financial_event() returns trigger language plpgsql security definer set search_path=public as $$
declare v_ref public.tablely_partner_referrals%rowtype; v_rule public.tablely_partner_commission_rules%rowtype; v_override public.tablely_partner_commission_overrides%rowtype; v_sub public.organization_subscriptions%rowtype; v_plan public.saas_plans%rowtype; v_base numeric(12,2); v_paid_amount numeric(12,2); v_count integer; v_comm public.tablely_partner_commissions%rowtype; v_new_commission uuid; v_payment_status text;
begin
 if upper(coalesce(new.status,'')) in ('REFUNDED','CHARGEBACK','DISPUTED') or lower(coalesce(new.event_type,'')) like '%refund%' or lower(coalesce(new.event_type,'')) like '%chargeback%' then
  if new.provider_payment_id is null then return new; end if;
  for v_comm in select * from public.tablely_partner_commissions where provider_payment_id=new.provider_payment_id and status<>'REVERSED' loop
   insert into public.tablely_partner_adjustments(partner_id,commission_id,billing_event_id,amount,reason) values(v_comm.partner_id,v_comm.id,new.id,-v_comm.commission_amount,'Refund or chargeback reversal') on conflict do nothing;
   if v_comm.status<>'PAID' then update public.tablely_partner_commissions set status='REVERSED' where id=v_comm.id; end if;
  end loop; return new;
 end if;
 v_payment_status:=upper(coalesce(new.payload#>>'{payload,payment,entity,status}',new.payload#>>'{payload,invoice,entity,status}',''));
 if upper(coalesce(new.status,'')) not in ('PAID','CAPTURED','SUCCEEDED','SUCCESS') and not (lower(coalesce(new.event_type,'')) like '%paid%' and v_payment_status in ('PAID','CAPTURED','SUCCEEDED','SUCCESS')) and not (lower(coalesce(new.event_type,'')) like '%charged%' and v_payment_status in ('PAID','CAPTURED','SUCCEEDED','SUCCESS')) then return new; end if;
 v_paid_amount:=coalesce(new.amount,case when (new.payload#>>'{payload,payment,entity,amount}') ~ '^[0-9]+$' then round((new.payload#>>'{payload,payment,entity,amount}')::numeric/100,2) when (new.payload#>>'{payload,invoice,entity,amount_paid}') ~ '^[0-9]+$' then round((new.payload#>>'{payload,invoice,entity,amount_paid}')::numeric/100,2) else null end);
 if new.organization_id is null or coalesce(v_paid_amount,0)<=0 then return new; end if;
 select r.* into v_ref from public.tablely_partner_referrals r join public.tablely_partners p on p.id=r.partner_id where r.restaurant_organization_id=new.organization_id and r.status in ('VERIFIED','SUBSCRIPTION_ACTIVE','COMMISSION_GENERATED','PAID') and p.status='APPROVED';
 if v_ref.id is null then return new; end if;
 select * into v_sub from public.organization_subscriptions where organization_id=new.organization_id; select * into v_plan from public.saas_plans where id=v_sub.plan_id; select * into v_rule from public.tablely_partner_commission_rules where plan_id=v_sub.plan_id;
 select * into v_override from public.tablely_partner_commission_overrides where partner_id=v_ref.partner_id and plan_id=v_sub.plan_id and active=true;
 if v_override.partner_id is not null then v_rule.percent:=v_override.percent; v_rule.commission_mode:=v_override.commission_mode; v_rule.commission_months:=v_override.commission_months; end if;
 if v_rule.plan_id is null or v_rule.percent<=0 then return new; end if;
 select count(*) into v_count from public.tablely_partner_commissions where referral_id=v_ref.id;
 if (v_rule.commission_mode='ONE_TIME' and v_count>0) or (v_rule.commission_months is not null and v_count>=v_rule.commission_months) then return new; end if;
 v_base:=case when v_rule.calculation_basis='PLAN_PRICE' then coalesce(v_sub.price_monthly_snapshot,v_plan.price_monthly,v_paid_amount) else v_paid_amount end;
 insert into public.tablely_partner_commissions(partner_id,referral_id,organization_id,billing_event_id,provider_payment_id,plan_id_snapshot,plan_name_snapshot,payment_amount,commission_basis,commission_rate,commission_amount,currency,eligible_at)
 values(v_ref.partner_id,v_ref.id,new.organization_id,new.id,new.provider_payment_id,v_plan.id,v_plan.name,v_paid_amount,v_rule.calculation_basis,v_rule.percent,round(v_base*v_rule.percent/100,2),coalesce(nullif(new.currency,''),new.payload#>>'{payload,payment,entity,currency}','INR'),now()+make_interval(days=>v_rule.holding_days)) on conflict(billing_event_id) do nothing returning id into v_new_commission;
 if v_new_commission is null then return new; end if;
 update public.tablely_partner_referrals set status='COMMISSION_GENERATED',updated_at=now() where id=v_ref.id;
 insert into public.tablely_partner_audit(partner_id,referral_id,action,details) values(v_ref.partner_id,v_ref.id,'COMMISSION_GENERATED',jsonb_build_object('billing_event_id',new.id,'plan_id',v_plan.id,'rate',v_rule.percent)); return new;
end $$;
drop trigger if exists tablely_partner_commission_after_billing_event on public.subscription_billing_events;
create trigger tablely_partner_commission_after_billing_event after insert or update on public.subscription_billing_events for each row execute function public.tablely_partner_financial_event();
create or replace function public.tablely_partner_release_commissions() returns integer language plpgsql security definer set search_path=public as $$ declare v_count integer; begin
 update public.tablely_partner_commissions c set status='PAYABLE' from public.tablely_partner_commission_rules r, public.tablely_partners p where c.plan_id_snapshot=r.plan_id and p.id=c.partner_id and p.status='APPROVED' and c.status in ('PENDING','APPROVED') and c.eligible_at<=now() and (select coalesce(sum(x.commission_amount),0) from public.tablely_partner_commissions x where x.partner_id=c.partner_id and x.status in ('PENDING','APPROVED','PAYABLE'))>=r.minimum_payout;
 get diagnostics v_count=row_count; return v_count; end $$;
revoke all on function public.tablely_partner_release_commissions() from public,anon,authenticated;
create or replace function public.tablely_partner_prevent_ledger_delete() returns trigger language plpgsql as $$ begin raise exception 'Partner financial ledger is immutable'; end $$;
create or replace function public.tablely_partner_guard_ledger_update() returns trigger language plpgsql as $$
begin
 if tg_table_name='tablely_partner_commissions' and row(new.partner_id,new.referral_id,new.organization_id,new.billing_event_id,new.provider_payment_id,new.plan_id_snapshot,new.plan_name_snapshot,new.payment_amount,new.commission_basis,new.commission_rate,new.commission_amount,new.currency,new.eligible_at,new.created_at) is distinct from row(old.partner_id,old.referral_id,old.organization_id,old.billing_event_id,old.provider_payment_id,old.plan_id_snapshot,old.plan_name_snapshot,old.payment_amount,old.commission_basis,old.commission_rate,old.commission_amount,old.currency,old.eligible_at,old.created_at) then raise exception 'Commission snapshots are immutable; add an adjustment entry'; end if;
 if tg_table_name='tablely_partner_payouts' and row(new.partner_id,new.amount,new.approved_by,new.approved_at,new.created_at) is distinct from row(old.partner_id,old.amount,old.approved_by,old.approved_at,old.created_at) then raise exception 'Payout approval records are immutable'; end if;
 if tg_table_name='tablely_partner_adjustments' or tg_table_name='tablely_partner_audit' then raise exception 'Append-only ledger records cannot be changed'; end if;
 return new;
end $$;
create trigger tablely_partner_commissions_immutable before update on public.tablely_partner_commissions for each row execute function public.tablely_partner_guard_ledger_update();
create trigger tablely_partner_payouts_immutable before update on public.tablely_partner_payouts for each row execute function public.tablely_partner_guard_ledger_update();
create trigger tablely_partner_adjustments_immutable before update on public.tablely_partner_adjustments for each row execute function public.tablely_partner_guard_ledger_update();
create trigger tablely_partner_audit_immutable before update on public.tablely_partner_audit for each row execute function public.tablely_partner_guard_ledger_update();
create trigger tablely_partner_commissions_no_delete before delete on public.tablely_partner_commissions for each row execute function public.tablely_partner_prevent_ledger_delete();
create trigger tablely_partner_adjustments_no_delete before delete on public.tablely_partner_adjustments for each row execute function public.tablely_partner_prevent_ledger_delete();
create trigger tablely_partner_payouts_no_delete before delete on public.tablely_partner_payouts for each row execute function public.tablely_partner_prevent_ledger_delete();
commit;
notify pgrst,'reload schema';
