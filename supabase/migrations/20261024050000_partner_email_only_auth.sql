begin;

alter table public.tablely_partners
  alter column phone drop not null;

create or replace function public.tablely_partner_register(
  p_full_name text,
  p_city text,
  p_state text,
  p_category text,
  p_company text,
  p_website text,
  p_source text,
  p_address text
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_user auth.users%rowtype;
  v_partner public.tablely_partners%rowtype;
  v_category text:=upper(trim(p_category));
begin
  select * into v_user from auth.users where id=auth.uid();
  if v_user.id is null or v_user.email_confirmed_at is null then
    raise exception 'Verify your email before applying' using errcode='42501';
  end if;
  if length(trim(coalesce(p_full_name,'')))<2
    or length(trim(coalesce(p_city,'')))<2
    or length(trim(coalesce(p_state,'')))<2
    or v_category not in ('STUDENT','FREELANCER','AGENCY','CONSULTANT','OTHER') then
    raise exception 'Complete all required partner details';
  end if;

  insert into public.tablely_partners(
    user_id,full_name,email,phone,city,state,category,company_name,website_url,
    referral_source,address,agreement_accepted_at
  )
  values(
    v_user.id,trim(p_full_name),lower(v_user.email),v_user.phone,trim(p_city),
    trim(p_state),v_category,nullif(trim(p_company),''),nullif(trim(p_website),''),
    nullif(trim(p_source),''),nullif(trim(p_address),''),now()
  )
  returning * into v_partner;

  insert into public.tablely_partner_audit(actor_user_id,partner_id,action)
  values(auth.uid(),v_partner.id,'PARTNER_APPLIED');

  return jsonb_build_object('id',v_partner.id,'code',v_partner.partner_code,'status',v_partner.status);
end;
$$;

commit;
