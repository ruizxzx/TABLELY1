begin;

alter table public.restaurant_customer_preferences
  add column if not exists feedback_email boolean not null default false,
  add column if not exists feedback_email_consent_at timestamptz,
  add column if not exists feedback_email_withdrawn_at timestamptz,
  add column if not exists feedback_email_consent_version text,
  add column if not exists feedback_email_consent_source text;

alter table public.restaurant_feedback_settings
  drop constraint if exists restaurant_feedback_settings_channel_check;
alter table public.restaurant_feedback_settings
  add constraint restaurant_feedback_settings_channel_check
  check(channel in ('IN_APP','WHATSAPP','EMAIL'));

create or replace function public.tablely_build32_queue_feedback_email()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_org uuid;
  v_customer uuid;
  v_phone text;
  v_email text;
  v_invitation_id uuid;
  v_delay integer;
begin
  if new.status::text<>'COMPLETED' or new.payment_status::text<>'PAID' then return new; end if;
  if tg_op='UPDATE'
     and old.status::text='COMPLETED'
     and old.payment_status::text='PAID' then return new; end if;

  select b.organization_id into v_org from public.branches b where b.id=new.branch_id;
  if v_org is null then return new; end if;

  select s.delay_minutes into v_delay
  from public.restaurant_feedback_settings s
  where s.organization_id=v_org and s.enabled and s.channel='EMAIL';
  if not found then return new; end if;

  v_customer:=new.customer_profile_id;
  v_phone:=nullif(right(regexp_replace(coalesce(new.customer_phone,''),'[^0-9]','','g'),10),'');
  select p.customer_id,p.email into v_customer,v_email
  from public.restaurant_customer_preferences p
  where p.organization_id=v_org
    and ((new.customer_profile_id is not null and p.customer_id=new.customer_profile_id)
      or (new.customer_profile_id is null and v_phone is not null and p.phone=v_phone))
    and p.feedback_email
    and p.feedback_email_consent_at is not null
    and p.feedback_email_withdrawn_at is null
    and p.email is not null
  order by p.updated_at desc
  limit 1;
  if v_email is null then return new; end if;

  insert into public.restaurant_feedback_invitations(
    organization_id,branch_id,order_id,customer_id,channel,status
  )
  values(v_org,new.branch_id,new.id,v_customer,'EMAIL','QUEUED')
  on conflict(order_id) do nothing;

  select i.id into v_invitation_id
  from public.restaurant_feedback_invitations i
  where i.order_id=new.id and i.organization_id=v_org and i.channel='EMAIL';
  if v_invitation_id is null then return new; end if;

  insert into public.restaurant_notification_queue(
    organization_id,branch_id,order_id,event_key,channel,recipient_hash,payload,idempotency_key,next_attempt_at
  )
  values(
    v_org,new.branch_id,new.id,'FEEDBACK_REQUEST','EMAIL',
    encode(digest(v_org::text||':'||lower(trim(v_email)),'sha256'),'hex'),
    jsonb_build_object('feedbackUrl','/feedback/'||v_invitation_id::text),
    'order:'||new.id::text||':FEEDBACK_EMAIL',
    now()+make_interval(mins=>coalesce(v_delay,0))
  )
  on conflict(idempotency_key) do nothing;
  return new;
end;
$$;

drop trigger if exists tablely_build32_feedback_email_queue_trigger on public.orders;
create trigger tablely_build32_feedback_email_queue_trigger
after insert or update of status,payment_status on public.orders
for each row execute function public.tablely_build32_queue_feedback_email();

revoke all on function public.tablely_build32_queue_feedback_email() from public,anon,authenticated;

notify pgrst, 'reload schema';
commit;
