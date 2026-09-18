-- Run once in Supabase SQL Editor.
-- Equivalent to migration 202609180029_feedback_reports.sql.

create table if not exists public.feedback_reports (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null, table_id uuid references public.tables(id) on delete set null,
  reporter_user_id uuid references auth.users(id) on delete set null, reporter_name text, reporter_email text,
  source text not null check (source in ('RESTAURANT','CUSTOMER')), category text not null check (category in ('BUG','IDEA','SUPPORT','OTHER')),
  subject text not null check (char_length(trim(subject)) between 3 and 160), description text not null check (char_length(trim(description)) between 5 and 4000),
  status text not null default 'OPEN' check (status in ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')), admin_note text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists feedback_reports_status_created_idx on public.feedback_reports(status,created_at desc);
create index if not exists feedback_reports_org_created_idx on public.feedback_reports(organization_id,created_at desc);
alter table public.feedback_reports enable row level security;
revoke all on public.feedback_reports from anon,authenticated,public;

create or replace function public.submit_customer_feedback(p_table_code text,p_category text,p_subject text,p_description text,p_reporter_name text default null,p_reporter_email text default null)
returns public.feedback_reports language plpgsql security definer set search_path=public as $$
declare v_table public.tables; v_report public.feedback_reports; v_category text:=upper(trim(coalesce(p_category,'OTHER')));
begin
  select t.* into v_table from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id where t.table_code=trim(coalesce(p_table_code,'')) and t.active and o.status='ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  if v_category not in('BUG','IDEA','SUPPORT','OTHER') then raise exception 'Invalid feedback category'; end if;
  insert into public.feedback_reports(organization_id,branch_id,table_id,reporter_user_id,reporter_name,reporter_email,source,category,subject,description)
  select b.organization_id,v_table.branch_id,v_table.id,auth.uid(),nullif(left(trim(coalesce(p_reporter_name,'')),120),''),nullif(left(trim(coalesce(p_reporter_email,'')),200),''),'CUSTOMER',v_category,left(trim(p_subject),160),left(trim(p_description),4000) from public.branches b where b.id=v_table.branch_id returning * into v_report;
  return v_report;
end; $$;

create or replace function public.submit_restaurant_feedback(p_category text,p_subject text,p_description text)
returns public.feedback_reports language plpgsql security definer set search_path=public as $$
declare v_staff public.staff%rowtype; v_org uuid; v_report public.feedback_reports; v_category text:=upper(trim(coalesce(p_category,'OTHER')));
begin
  select s.* into v_staff from public.staff s where s.user_id=auth.uid() and s.active order by case when s.role='OWNER' then 0 else 1 end,s.created_at limit 1;
  if v_staff.id is null then raise exception 'Restaurant workspace not found'; end if;
  select s.organization_id into v_org from public.staff s where s.id=v_staff.id;
  if v_category not in('BUG','IDEA','SUPPORT','OTHER') then raise exception 'Invalid feedback category'; end if;
  insert into public.feedback_reports(organization_id,branch_id,reporter_user_id,reporter_name,reporter_email,source,category,subject,description)
  select v_org,v_staff.branch_id,auth.uid(),p.full_name,u.email,'RESTAURANT',v_category,left(trim(p_subject),160),left(trim(p_description),4000) from public.profiles p join auth.users u on u.id=auth.uid() where p.id=auth.uid() returning * into v_report;
  return v_report;
end; $$;

create or replace function public.admin_list_feedback_reports(p_limit integer default 300)
returns table(id uuid,organization_name text,branch_id uuid,source text,category text,subject text,description text,reporter_name text,reporter_email text,status text,admin_note text,created_at timestamptz,updated_at timestamptz)
language plpgsql security definer stable set search_path=public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  return query select f.id,o.name,f.branch_id,f.source,f.category,f.subject,f.description,f.reporter_name,f.reporter_email,f.status,f.admin_note,f.created_at,f.updated_at from public.feedback_reports f join public.organizations o on o.id=f.organization_id order by f.created_at desc limit greatest(1,least(coalesce(p_limit,300),1000));
end; $$;

create or replace function public.admin_update_feedback_report(p_id uuid,p_status text,p_admin_note text default null)
returns public.feedback_reports language plpgsql security definer set search_path=public as $$
declare v_report public.feedback_reports;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  if upper(trim(p_status)) not in('OPEN','IN_PROGRESS','RESOLVED','CLOSED') then raise exception 'Invalid feedback status'; end if;
  update public.feedback_reports set status=upper(trim(p_status)),admin_note=left(nullif(trim(p_admin_note),''),4000),updated_at=now() where id=p_id returning * into v_report;
  if v_report.id is null then raise exception 'Feedback report not found'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata) values(auth.uid(),'FEEDBACK_UPDATED','FEEDBACK_REPORT',p_id,jsonb_build_object('status',v_report.status));
  return v_report;
end; $$;

grant execute on function public.submit_customer_feedback(text,text,text,text,text,text) to anon,authenticated;
grant execute on function public.submit_restaurant_feedback(text,text,text) to authenticated;
grant execute on function public.admin_list_feedback_reports(integer) to authenticated;
grant execute on function public.admin_update_feedback_report(uuid,text,text) to authenticated;
