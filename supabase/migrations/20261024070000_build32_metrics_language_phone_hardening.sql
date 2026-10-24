begin;

update public.restaurant_customer_preferences
set phone = right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)
where customer_id is null
  and phone is not null
  and length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10;

with ranked as (
  select id, row_number() over (
    partition by organization_id, phone
    order by updated_at desc, id desc
  ) as position
  from public.restaurant_customer_preferences
  where customer_id is null and phone is not null
)
delete from public.restaurant_customer_preferences p
using ranked r
where p.id = r.id and r.position > 1;

alter table public.restaurant_customer_preferences
  add column if not exists anonymous_phone_key text
  generated always as (case when customer_id is null then phone else null end) stored;

create unique index if not exists restaurant_customer_preferences_anon_phone_uidx
  on public.restaurant_customer_preferences (organization_id, anonymous_phone_key);

create or replace function public.restaurant_engagement_branch_metrics(
  p_organization_id uuid,
  p_branch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.branches
    where id = p_branch_id and organization_id = p_organization_id
  ) then
    raise exception 'Branch does not belong to organization' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'whatsappDelivered', (select count(*) from public.restaurant_notification_queue
      where organization_id = p_organization_id and branch_id = p_branch_id and channel = 'WHATSAPP' and status in ('DELIVERED', 'READ')),
    'whatsappFailed', (select count(*) from public.restaurant_notification_queue
      where organization_id = p_organization_id and branch_id = p_branch_id and channel = 'WHATSAPP' and status = 'FAILED'),
    'loyaltyMembers', (select count(distinct customer_id) from public.restaurant_loyalty_ledger
      where organization_id = p_organization_id and branch_id = p_branch_id and entry_type = 'EARN'),
    'pointsIssued', (select coalesce(sum(greatest(points, 0)), 0) from public.restaurant_loyalty_ledger
      where organization_id = p_organization_id and branch_id = p_branch_id and entry_type = 'EARN'),
    'pointsRedeemed', (select coalesce(sum(abs(points)), 0) from public.restaurant_loyalty_ledger
      where organization_id = p_organization_id and branch_id = p_branch_id and entry_type = 'REDEEM'),
    'feedbackCount', (select count(*) from public.restaurant_customer_feedback
      where organization_id = p_organization_id and branch_id = p_branch_id),
    'feedbackAverage', (select avg(rating) from public.restaurant_customer_feedback
      where organization_id = p_organization_id and branch_id = p_branch_id),
    'reviewCount', (select count(*) from public.restaurant_google_reviews
      where organization_id = p_organization_id and branch_id = p_branch_id),
    'reviewAverage', (select avg(star_rating) from public.restaurant_google_reviews
      where organization_id = p_organization_id and branch_id = p_branch_id),
    'reviewClicks', (select count(*) from public.restaurant_review_invitations
      where organization_id = p_organization_id and branch_id = p_branch_id and clicked_at is not null),
    'unreplied', (select count(*) from public.restaurant_google_reviews
      where organization_id = p_organization_id and branch_id = p_branch_id and owner_reply is null)
  );
end;
$$;

revoke all on function public.restaurant_engagement_branch_metrics(uuid, uuid) from public, anon, authenticated;
grant execute on function public.restaurant_engagement_branch_metrics(uuid, uuid) to service_role;

create or replace function public.get_public_menu_language_settings_for_table(p_table_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'defaultLanguage', coalesce(settings.default_language, 'en'),
    'enabledLanguages', coalesce(to_jsonb(settings.enabled_languages), '["en"]'::jsonb)
  )
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  left join public.restaurant_language_settings settings on settings.organization_id = b.organization_id
  where t.table_code = trim(p_table_code)
    and t.active = true
    and o.status::text = 'ACTIVE'
  limit 1;
$$;

grant execute on function public.get_public_menu_language_settings_for_table(text) to anon, authenticated;
revoke execute on function public.get_public_menu_language_settings_for_table(text) from public;

commit;
