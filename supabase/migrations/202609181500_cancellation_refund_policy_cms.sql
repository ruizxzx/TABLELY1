-- Adds the Cancellation & Refund Policy as a fifth editable public content
-- page, using the same platform_content_pages CMS as contact/vision/privacy/terms.

alter table public.platform_content_pages drop constraint if exists platform_content_pages_slug_check;
alter table public.platform_content_pages add constraint platform_content_pages_slug_check
  check (slug in ('contact','vision','privacy','terms','cancellation-refund-policy'));

insert into public.platform_content_pages (slug, title, draft, published, is_published)
values
(
  'cancellation-refund-policy',
  'Cancellation & Refund Policy',
  jsonb_build_object(
    'title','Cancellation & Refund Policy',
    'intro','Effective Date: 18 September 2026' || chr(10) || chr(10) || 'TABLELY provides restaurant technology and SaaS services, including digital ordering, table management, menu management, payment-related tools, customer management, and related software features.',
    'sections',jsonb_build_array(
      jsonb_build_object('heading','1. Subscription Cancellation','body','Customers may cancel their TABLELY subscription at any time through their TABLELY account or by contacting our support team.' || chr(10) || chr(10) || 'Cancellation will prevent future subscription renewals. The subscription will normally remain active until the end of the current paid billing period.'),
      jsonb_build_object('heading','2. Refunds','body','Subscription fees are generally non-refundable once a billing period has started, except in the following circumstances:' || chr(10) || chr(10) || '- A duplicate payment was charged.' || chr(10) || '- A payment was charged incorrectly due to a technical error.' || chr(10) || '- TABLELY authorizes a refund at its discretion where appropriate.' || chr(10) || '- A refund is required under applicable law.' || chr(10) || chr(10) || 'Approved refunds will normally be processed back to the original payment method used for the transaction. The time taken for the refunded amount to appear in the customer''s account may depend on the customer''s bank or payment provider.'),
      jsonb_build_object('heading','3. Failed or Duplicate Payments','body','If a payment is deducted but the TABLELY service is not activated because of a payment-processing failure, the transaction will be reviewed and any amount incorrectly charged will be refunded or otherwise reconciled.' || chr(10) || chr(10) || 'Duplicate transactions will be eligible for refund after verification.'),
      jsonb_build_object('heading','4. How to Request a Refund','body','To request a cancellation or refund, contact:' || chr(10) || chr(10) || 'Email: support@tablely.in' || chr(10) || chr(10) || 'Please provide:' || chr(10) || chr(10) || '- Account name' || chr(10) || '- Registered email address' || chr(10) || '- Transaction/payment reference' || chr(10) || '- Date of payment' || chr(10) || '- Reason for the request' || chr(10) || chr(10) || 'We may request additional information to verify the transaction.'),
      jsonb_build_object('heading','5. Processing Time','body','Once a refund is approved, TABLELY will initiate the refund to the original payment method. The final credit time depends on the payment gateway, bank, or card issuer.'),
      jsonb_build_object('heading','6. Contact','body','For cancellation, refund, or payment-related questions:' || chr(10) || chr(10) || 'TABLELY Support' || chr(10) || 'Website: https://www.tablely.in/' || chr(10) || 'Email: support@tablely.in')
    )
  ),
  jsonb_build_object(
    'title','Cancellation & Refund Policy',
    'intro','Effective Date: 18 September 2026' || chr(10) || chr(10) || 'TABLELY provides restaurant technology and SaaS services, including digital ordering, table management, menu management, payment-related tools, customer management, and related software features.',
    'sections',jsonb_build_array(
      jsonb_build_object('heading','1. Subscription Cancellation','body','Customers may cancel their TABLELY subscription at any time through their TABLELY account or by contacting our support team.' || chr(10) || chr(10) || 'Cancellation will prevent future subscription renewals. The subscription will normally remain active until the end of the current paid billing period.'),
      jsonb_build_object('heading','2. Refunds','body','Subscription fees are generally non-refundable once a billing period has started, except in the following circumstances:' || chr(10) || chr(10) || '- A duplicate payment was charged.' || chr(10) || '- A payment was charged incorrectly due to a technical error.' || chr(10) || '- TABLELY authorizes a refund at its discretion where appropriate.' || chr(10) || '- A refund is required under applicable law.' || chr(10) || chr(10) || 'Approved refunds will normally be processed back to the original payment method used for the transaction. The time taken for the refunded amount to appear in the customer''s account may depend on the customer''s bank or payment provider.'),
      jsonb_build_object('heading','3. Failed or Duplicate Payments','body','If a payment is deducted but the TABLELY service is not activated because of a payment-processing failure, the transaction will be reviewed and any amount incorrectly charged will be refunded or otherwise reconciled.' || chr(10) || chr(10) || 'Duplicate transactions will be eligible for refund after verification.'),
      jsonb_build_object('heading','4. How to Request a Refund','body','To request a cancellation or refund, contact:' || chr(10) || chr(10) || 'Email: support@tablely.in' || chr(10) || chr(10) || 'Please provide:' || chr(10) || chr(10) || '- Account name' || chr(10) || '- Registered email address' || chr(10) || '- Transaction/payment reference' || chr(10) || '- Date of payment' || chr(10) || '- Reason for the request' || chr(10) || chr(10) || 'We may request additional information to verify the transaction.'),
      jsonb_build_object('heading','5. Processing Time','body','Once a refund is approved, TABLELY will initiate the refund to the original payment method. The final credit time depends on the payment gateway, bank, or card issuer.'),
      jsonb_build_object('heading','6. Contact','body','For cancellation, refund, or payment-related questions:' || chr(10) || chr(10) || 'TABLELY Support' || chr(10) || 'Website: https://www.tablely.in/' || chr(10) || 'Email: support@tablely.in')
    )
  ),
  true
)
on conflict (slug) do nothing;

create or replace function public.admin_list_public_content_pages()
returns table(
  slug text,
  title text,
  is_published boolean,
  version integer,
  updated_at timestamptz,
  published_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode='42501';
  end if;
  return query
  select p.slug,p.title,p.is_published,p.version,p.updated_at,p.published_at
  from public.platform_content_pages p
  order by array_position(array['contact','vision','privacy','terms','cancellation-refund-policy'], p.slug);
end;
$$;
grant execute on function public.admin_list_public_content_pages() to authenticated;

create or replace function public.admin_save_public_content_page(
  p_slug text,
  p_title text,
  p_draft jsonb
)
returns public.platform_content_pages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.platform_content_pages;
  v_slug text := lower(trim(coalesce(p_slug,'')));
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode='42501';
  end if;
  if v_slug not in ('contact','vision','privacy','terms','cancellation-refund-policy') then
    raise exception 'Unknown content page';
  end if;
  if p_draft is null or jsonb_typeof(p_draft) <> 'object' then
    raise exception 'Content must be a JSON object';
  end if;
  if char_length(trim(coalesce(p_title,''))) < 2 then
    raise exception 'Content page title is required';
  end if;
  update public.platform_content_pages
  set title = left(trim(coalesce(p_title,'')),180),
      draft = p_draft,
      updated_at = now(),
      updated_by = auth.uid()
  where slug = v_slug
  returning * into v_row;
  if v_row.slug is null then raise exception 'Content page not found'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(auth.uid(),'PLATFORM_CONTENT_UPDATED','PLATFORM_CONTENT',v_row.id,jsonb_build_object('slug',v_slug));
  return v_row;
end;
$$;
grant execute on function public.admin_save_public_content_page(text,text,jsonb) to authenticated;

select pg_notify('pgrst','reload schema');
