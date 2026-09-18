-- TABLELY — Public content CMS + enterprise contact inbox.
-- Additive migration. Does not alter restaurant operational/session/payment architecture.

create table if not exists public.platform_content_pages (
  slug text primary key,
  title text not null,
  draft jsonb not null default '{}'::jsonb,
  published jsonb not null default '{}'::jsonb,
  is_published boolean not null default true,
  version integer not null default 1 check (version > 0),
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  published_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint platform_content_pages_slug_check check (slug in ('contact','vision','privacy','terms'))
);

alter table public.platform_content_pages enable row level security;
revoke all on public.platform_content_pages from anon, authenticated, public;

insert into public.platform_content_pages (slug, title, draft, published, is_published)
values
(
  'contact',
  'Contact TABLELY',
  jsonb_build_object(
    'eyebrow','TABLELY ENTERPRISE',
    'title','Let’s build the right setup.',
    'description','Tell us about your restaurants or restaurant group and our team will get in touch within 24 hours.',
    'email','krishsarkar456@gmail.com',
    'location','India, Kolkata',
    'response_time','Within 24 hours',
    'form_title','Start a conversation',
    'form_description','Tell us what you are building, how many locations you have, and what you need from TABLELY.',
    'success_message','Thanks for reaching out. Your message has been received. Our team will get in touch within 24 hours.',
    'form_cta','Send inquiry'
  ),
  jsonb_build_object(
    'eyebrow','TABLELY ENTERPRISE',
    'title','Let’s build the right setup.',
    'description','Tell us about your restaurants or restaurant group and our team will get in touch within 24 hours.',
    'email','krishsarkar456@gmail.com',
    'location','India, Kolkata',
    'response_time','Within 24 hours',
    'form_title','Start a conversation',
    'form_description','Tell us what you are building, how many locations you have, and what you need from TABLELY.',
    'success_message','Thanks for reaching out. Your message has been received. Our team will get in touch within 24 hours.',
    'form_cta','Send inquiry'
  ), true
),
(
  'vision',
  'My Vision',
  jsonb_build_object(
    'eyebrow','THE VISION BEHIND TABLELY',
    'title','Building a simpler way for restaurants to operate.',
    'intro','TABLELY is being built around a simple idea: technology should remove unnecessary friction from the restaurant experience instead of adding another complicated system for staff and customers to manage.',
    'vision_heading','My vision',
    'vision_body','Make restaurant technology simpler to adopt, easier to understand, and useful enough to become part of the everyday shift.',
    'problem_heading','The problem',
    'problem_items',jsonb_build_array('Manual ordering creates avoidable work.','Restaurant teams often work across disconnected tools.','Slow communication between floor and kitchen creates friction.','Payment, customer, and operational information can become fragmented.','Smaller restaurants should not need enterprise-level complexity to access useful technology.'),
    'idea_heading','The idea',
    'idea_body','One connected system where the customer experience and restaurant operation support each other from the first QR scan to the final payment and feedback.',
    'customer_flow',jsonb_build_array('Menu','Order','Kitchen','Service','Payment','Feedback'),
    'restaurant_flow',jsonb_build_array('Operations','Staff','Customers','Payments','Analytics'),
    'build_heading','What I want to build',
    'build_body','A long-term restaurant platform that starts with QR ordering and grows into a practical operating system for restaurants of every size.',
    'principles',jsonb_build_array(
      jsonb_build_object('title','Simple','copy','Useful without unnecessary complexity.'),
      jsonb_build_object('title','Useful','copy','Every feature should solve a real restaurant problem.'),
      jsonb_build_object('title','Fast','copy','The system should keep the shift moving.'),
      jsonb_build_object('title','Transparent','copy','Owners should understand what the platform is doing.'),
      jsonb_build_object('title','Scalable','copy','A small restaurant should be able to grow without replacing its system.')
    ),
    'founder',jsonb_build_object(
      'name','Krish Sarkar',
      'title','Founder / Builder',
      'bio','Building TABLELY with a focus on making restaurant technology more approachable, connected, and practical.',
      'quote','Build the system restaurants actually need.',
      'image_url',null,
      'image_path',null
    )
  ),
  jsonb_build_object(
    'eyebrow','THE VISION BEHIND TABLELY',
    'title','Building a simpler way for restaurants to operate.',
    'intro','TABLELY is being built around a simple idea: technology should remove unnecessary friction from the restaurant experience instead of adding another complicated system for staff and customers to manage.',
    'vision_heading','My vision',
    'vision_body','Make restaurant technology simpler to adopt, easier to understand, and useful enough to become part of the everyday shift.',
    'problem_heading','The problem',
    'problem_items',jsonb_build_array('Manual ordering creates avoidable work.','Restaurant teams often work across disconnected tools.','Slow communication between floor and kitchen creates friction.','Payment, customer, and operational information can become fragmented.','Smaller restaurants should not need enterprise-level complexity to access useful technology.'),
    'idea_heading','The idea',
    'idea_body','One connected system where the customer experience and restaurant operation support each other from the first QR scan to the final payment and feedback.',
    'customer_flow',jsonb_build_array('Menu','Order','Kitchen','Service','Payment','Feedback'),
    'restaurant_flow',jsonb_build_array('Operations','Staff','Customers','Payments','Analytics'),
    'build_heading','What I want to build',
    'build_body','A long-term restaurant platform that starts with QR ordering and grows into a practical operating system for restaurants of every size.',
    'principles',jsonb_build_array(
      jsonb_build_object('title','Simple','copy','Useful without unnecessary complexity.'),
      jsonb_build_object('title','Useful','copy','Every feature should solve a real restaurant problem.'),
      jsonb_build_object('title','Fast','copy','The system should keep the shift moving.'),
      jsonb_build_object('title','Transparent','copy','Owners should understand what the platform is doing.'),
      jsonb_build_object('title','Scalable','copy','A small restaurant should be able to grow without replacing its system.')
    ),
    'founder',jsonb_build_object(
      'name','Krish Sarkar',
      'title','Founder / Builder',
      'bio','Building TABLELY with a focus on making restaurant technology more approachable, connected, and practical.',
      'quote','Build the system restaurants actually need.',
      'image_url',null,
      'image_path',null
    )
  ), true
),
(
  'privacy',
  'Privacy policy',
  jsonb_build_object(
    'title','Privacy policy',
    'intro','Tablely helps restaurants manage QR ordering, orders, payments, staff operations, and customer accounts. This policy explains the information used to provide those services.',
    'sections',jsonb_build_array(
      jsonb_build_object('heading','Information we use','body','Depending on how you use Tablely, we may process account details, restaurant and staff details, customer profile information, table and visit context, order and payment records, support messages, and technical information needed to keep the service secure.'),
      jsonb_build_object('heading','How information is used','body','We use this information to authenticate users, process orders and payments, maintain restaurant operations, provide customer order history and receipts, prevent fraud, respond to support requests, and improve reliability.'),
      jsonb_build_object('heading','Payments and providers','body','Online payments are handled through the configured payment provider. Tablely records payment status and transaction references needed for reconciliation; full payment credentials are not stored by Tablely.'),
      jsonb_build_object('heading','Access and retention','body','Restaurant data is scoped to the relevant organization and authorized branches. Customer data is scoped to the authenticated customer and their restaurant relationships. Financial, order, security, and audit records may need to be retained even when an account is deleted.'),
      jsonb_build_object('heading','Your choices','body','You may request access, correction, or deletion of eligible account information. Some historical records may be retained or anonymized when deletion would compromise financial, legal, or security obligations.'),
      jsonb_build_object('heading','Contact','body','For privacy questions or requests, contact the Tablely administrator at krishsarkar456@gmail.com.')
    )
  ),
  jsonb_build_object(
    'title','Privacy policy',
    'intro','Tablely helps restaurants manage QR ordering, orders, payments, staff operations, and customer accounts. This policy explains the information used to provide those services.',
    'sections',jsonb_build_array(
      jsonb_build_object('heading','Information we use','body','Depending on how you use Tablely, we may process account details, restaurant and staff details, customer profile information, table and visit context, order and payment records, support messages, and technical information needed to keep the service secure.'),
      jsonb_build_object('heading','How information is used','body','We use this information to authenticate users, process orders and payments, maintain restaurant operations, provide customer order history and receipts, prevent fraud, respond to support requests, and improve reliability.'),
      jsonb_build_object('heading','Payments and providers','body','Online payments are handled through the configured payment provider. Tablely records payment status and transaction references needed for reconciliation; full payment credentials are not stored by Tablely.'),
      jsonb_build_object('heading','Access and retention','body','Restaurant data is scoped to the relevant organization and authorized branches. Customer data is scoped to the authenticated customer and their restaurant relationships. Financial, order, security, and audit records may need to be retained even when an account is deleted.'),
      jsonb_build_object('heading','Your choices','body','You may request access, correction, or deletion of eligible account information. Some historical records may be retained or anonymized when deletion would compromise financial, legal, or security obligations.'),
      jsonb_build_object('heading','Contact','body','For privacy questions or requests, contact the Tablely administrator at krishsarkar456@gmail.com.')
    )
  ), true
),
(
  'terms',
  'Terms and conditions',
  jsonb_build_object(
    'title','Terms and conditions',
    'intro','These terms govern use of Tablely by restaurant organizations, staff, and customers. Tablely is a software service; each restaurant remains responsible for its menu, pricing, taxes, fulfillment, refunds, and customer communications.',
    'sections',jsonb_build_array(
      jsonb_build_object('heading','Restaurant accounts','body','Organizations must provide accurate account information, protect staff access, and use branch permissions appropriately. Account owners are responsible for activity performed through their organization.'),
      jsonb_build_object('heading','Customer ordering and payments','body','Customers must provide accurate ordering details and use the payment method selected at checkout. Orders, payment states, cancellations, and Pay-Later eligibility are governed by the restaurant’s configured operational rules.'),
      jsonb_build_object('heading','Acceptable use','body','Do not misuse the service, attempt unauthorized access, interfere with payment or order processing, submit abusive content, or access another organization’s data.'),
      jsonb_build_object('heading','Subscriptions and suspension','body','Restaurant subscriptions and plan entitlements are subject to the selected plan and billing records. Tablely may restrict or suspend access for abuse, security concerns, non-payment, or violation of these terms.'),
      jsonb_build_object('heading','Content and responsibility','body','Restaurants are responsible for menu content, prices, availability, legal compliance, and customer service. Customers are responsible for reviewing their order before submission.'),
      jsonb_build_object('heading','Service limitations','body','Tablely is provided on an availability basis. We work to keep the service reliable, but cannot guarantee uninterrupted access or accept responsibility for events outside reasonable control.'),
      jsonb_build_object('heading','Contact','body','For support, contact the Tablely administrator at krishsarkar456@gmail.com or the organization operating your restaurant workspace.')
    )
  ),
  jsonb_build_object(
    'title','Terms and conditions',
    'intro','These terms govern use of Tablely by restaurant organizations, staff, and customers. Tablely is a software service; each restaurant remains responsible for its menu, pricing, taxes, fulfillment, refunds, and customer communications.',
    'sections',jsonb_build_array(
      jsonb_build_object('heading','Restaurant accounts','body','Organizations must provide accurate account information, protect staff access, and use branch permissions appropriately. Account owners are responsible for activity performed through their organization.'),
      jsonb_build_object('heading','Customer ordering and payments','body','Customers must provide accurate ordering details and use the payment method selected at checkout. Orders, payment states, cancellations, and Pay-Later eligibility are governed by the restaurant’s configured operational rules.'),
      jsonb_build_object('heading','Acceptable use','body','Do not misuse the service, attempt unauthorized access, interfere with payment or order processing, submit abusive content, or access another organization’s data.'),
      jsonb_build_object('heading','Subscriptions and suspension','body','Restaurant subscriptions and plan entitlements are subject to the selected plan and billing records. Tablely may restrict or suspend access for abuse, security concerns, non-payment, or violation of these terms.'),
      jsonb_build_object('heading','Content and responsibility','body','Restaurants are responsible for menu content, prices, availability, legal compliance, and customer service. Customers are responsible for reviewing their order before submission.'),
      jsonb_build_object('heading','Service limitations','body','Tablely is provided on an availability basis. We work to keep the service reliable, but cannot guarantee uninterrupted access or accept responsibility for events outside reasonable control.'),
      jsonb_build_object('heading','Contact','body','For support, contact the Tablely administrator at krishsarkar456@gmail.com or the organization operating your restaurant workspace.')
    )
  ), true
)
on conflict (slug) do nothing;

create table if not exists public.contact_submissions (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  email text not null check (char_length(trim(email)) between 5 and 240),
  phone text,
  company_name text,
  restaurant_count integer check (restaurant_count is null or (restaurant_count between 1 and 100000)),
  subject text not null check (char_length(trim(subject)) between 3 and 160),
  message text not null check (char_length(trim(message)) between 5 and 6000),
  status text not null default 'NEW' check (status in ('NEW','IN_PROGRESS','CONTACTED','CONVERTED','CLOSED')),
  admin_note text,
  handled_by uuid references auth.users(id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contact_submissions_created_idx on public.contact_submissions(created_at desc);
create index if not exists contact_submissions_status_created_idx on public.contact_submissions(status, created_at desc);
create index if not exists contact_submissions_email_created_idx on public.contact_submissions(lower(email), created_at desc);

alter table public.contact_submissions enable row level security;
revoke all on public.contact_submissions from anon, authenticated, public;

create or replace function public.get_public_content_page(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'slug', slug,
    'title', title,
    'content', published,
    'version', version,
    'published_at', published_at
  )
  from public.platform_content_pages
  where slug = lower(trim(coalesce(p_slug,'')))
    and is_published = true;
$$;
grant execute on function public.get_public_content_page(text) to anon, authenticated;

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
  order by array_position(array['contact','vision','privacy','terms'], p.slug);
end;
$$;
grant execute on function public.admin_list_public_content_pages() to authenticated;

create or replace function public.admin_get_public_content_page(p_slug text)
returns public.platform_content_pages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.platform_content_pages;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode='42501';
  end if;
  select * into v_row
  from public.platform_content_pages
  where slug = lower(trim(coalesce(p_slug,'')));
  if v_row.slug is null then
    raise exception 'Unknown content page';
  end if;
  return v_row;
end;
$$;
grant execute on function public.admin_get_public_content_page(text) to authenticated;

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
  if v_slug not in ('contact','vision','privacy','terms') then
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

create or replace function public.admin_publish_public_content_page(p_slug text)
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
  update public.platform_content_pages
  set published = draft,
      is_published = true,
      version = version + 1,
      published_at = now(),
      published_by = auth.uid(),
      updated_at = now(),
      updated_by = auth.uid()
  where slug = v_slug
  returning * into v_row;
  if v_row.slug is null then raise exception 'Content page not found'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(auth.uid(),'PLATFORM_CONTENT_PUBLISHED','PLATFORM_CONTENT',v_row.id,jsonb_build_object('slug',v_slug,'version',v_row.version));
  return v_row;
end;
$$;
grant execute on function public.admin_publish_public_content_page(text) to authenticated;

create or replace function public.admin_unpublish_public_content_page(p_slug text)
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
  update public.platform_content_pages
  set is_published = false,
      updated_at = now(),
      updated_by = auth.uid()
  where slug = v_slug
  returning * into v_row;
  if v_row.slug is null then raise exception 'Content page not found'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(auth.uid(),'PLATFORM_CONTENT_UNPUBLISHED','PLATFORM_CONTENT',v_row.id,jsonb_build_object('slug',v_slug));
  return v_row;
end;
$$;
grant execute on function public.admin_unpublish_public_content_page(text) to authenticated;

create or replace function public.submit_public_contact(
  p_name text,
  p_email text,
  p_phone text default null,
  p_company_name text default null,
  p_restaurant_count integer default null,
  p_subject text default 'TABLELY enquiry',
  p_message text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_name text := trim(coalesce(p_name,''));
  v_email text := lower(trim(coalesce(p_email,'')));
  v_subject text := trim(coalesce(p_subject,''));
  v_message text := trim(coalesce(p_message,''));
begin
  if char_length(v_name) < 2 or char_length(v_name) > 120 then raise exception 'Please enter your name.' using errcode='22023'; end if;
  if v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Please enter a valid email address.' using errcode='22023'; end if;
  if char_length(v_subject) < 3 or char_length(v_subject) > 160 then raise exception 'Please enter a subject.' using errcode='22023'; end if;
  if char_length(v_message) < 5 or char_length(v_message) > 6000 then raise exception 'Please enter a message.' using errcode='22023'; end if;
  if p_restaurant_count is not null and (p_restaurant_count < 1 or p_restaurant_count > 100000) then raise exception 'Enter a valid restaurant count.' using errcode='22023'; end if;

  if exists (
    select 1 from public.contact_submissions c
    where lower(c.email)=v_email
      and c.subject=v_subject
      and c.message=v_message
      and c.created_at >= now()-interval '2 minutes'
  ) then
    raise exception 'We already received that message. Please wait before sending it again.' using errcode='55000';
  end if;

  insert into public.contact_submissions(name,email,phone,company_name,restaurant_count,subject,message)
  values(
    v_name,
    v_email,
    nullif(left(trim(coalesce(p_phone,'')),40),''),
    nullif(left(trim(coalesce(p_company_name,'')),180),''),
    p_restaurant_count,
    v_subject,
    v_message
  ) returning id into v_id;

  return v_id;
end;
$$;
grant execute on function public.submit_public_contact(text,text,text,text,integer,text,text) to anon, authenticated;

create or replace function public.admin_list_contact_submissions(p_limit integer default 250)
returns table(
  id uuid,
  name text,
  email text,
  phone text,
  company_name text,
  restaurant_count integer,
  subject text,
  message text,
  status text,
  admin_note text,
  handled_by uuid,
  handled_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  return query
  select c.id,c.name,c.email,c.phone,c.company_name,c.restaurant_count,c.subject,c.message,c.status,c.admin_note,c.handled_by,c.handled_at,c.created_at,c.updated_at
  from public.contact_submissions c
  order by c.created_at desc
  limit greatest(1,least(coalesce(p_limit,250),1000));
end;
$$;
grant execute on function public.admin_list_contact_submissions(integer) to authenticated;

create or replace function public.admin_update_contact_submission(
  p_id uuid,
  p_status text,
  p_admin_note text default null
)
returns public.contact_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.contact_submissions;
  v_status text := upper(trim(coalesce(p_status,'')));
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  if v_status not in ('NEW','IN_PROGRESS','CONTACTED','CONVERTED','CLOSED') then raise exception 'Invalid contact status'; end if;
  update public.contact_submissions
  set status=v_status,
      admin_note=nullif(left(trim(coalesce(p_admin_note,'')),4000),''),
      handled_by=case when v_status in ('CONTACTED','CONVERTED','CLOSED') then auth.uid() else handled_by end,
      handled_at=case when v_status in ('CONTACTED','CONVERTED','CLOSED') then now() else handled_at end,
      updated_at=now()
  where id=p_id
  returning * into v_row;
  if v_row.id is null then raise exception 'Contact submission not found'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(auth.uid(),'CONTACT_SUBMISSION_UPDATED','CONTACT_SUBMISSION',v_row.id,jsonb_build_object('status',v_status));
  return v_row;
end;
$$;
grant execute on function public.admin_update_contact_submission(uuid,text,text) to authenticated;

select pg_notify('pgrst','reload schema');
