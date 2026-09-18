-- TABLELY BUILD 12 — Multi-branch, advanced analytics, permissions, branding & domains
-- Additive/idempotent migration.

create extension if not exists pgcrypto with schema extensions;

alter table public.organizations add column if not exists brand_logo_url text;
alter table public.organizations add column if not exists brand_primary_color text not null default '#111111';
alter table public.organizations add column if not exists brand_secondary_color text not null default '#f5f5f5';
alter table public.organizations add column if not exists brand_accent_color text not null default '#ee7c30';
alter table public.organizations add column if not exists customer_theme text not null default 'minimal';
alter table public.organizations add column if not exists brand_menu_header text;

alter table public.branches add column if not exists is_active boolean not null default true;
alter table public.branches add column if not exists timezone text not null default 'Asia/Kolkata';

create table if not exists public.staff_permissions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id) on delete cascade,
  permission text not null,
  allowed boolean not null default true,
  updated_at timestamptz not null default now(),
  unique(staff_id, permission)
);
create index if not exists staff_permissions_staff_idx on public.staff_permissions(staff_id);
alter table public.staff_permissions enable row level security;

create table if not exists public.organization_domains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  hostname text not null unique,
  verification_token text not null default encode(gen_random_bytes(18), 'hex'),
  status text not null default 'PENDING' check(status in ('PENDING','VERIFIED','DISABLED')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists organization_domains_org_idx on public.organization_domains(organization_id);
alter table public.organization_domains enable row level security;

create or replace function public.has_staff_permission(p_staff_id uuid, p_permission text)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.staff_permissions sp
    join public.staff s on s.id = sp.staff_id
    where sp.staff_id = p_staff_id and sp.permission = upper(trim(p_permission))
      and sp.allowed = true and s.user_id = auth.uid() and s.active = true
  );
$$;
grant execute on function public.has_staff_permission(uuid,text) to authenticated;

create or replace function public.can_manage_permissions(p_staff_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.staff s where s.id=p_staff_id and s.user_id=auth.uid() and s.active and s.role='OWNER');
$$;
grant execute on function public.can_manage_permissions(uuid) to authenticated;

create or replace function public.ensure_default_staff_permissions()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.staff_permissions(staff_id,permission,allowed)
  select new.id, p.permission, true
  from unnest(array['VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS','BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','ANALYTICS','SETTINGS','MENU_MANAGEMENT','BRANCH_MANAGEMENT','SUBSCRIPTION_MANAGEMENT']::text[]) p(permission)
  on conflict (staff_id,permission) do nothing;
  return new;
end;
$$;
drop trigger if exists staff_default_permissions on public.staff;
create trigger staff_default_permissions after insert on public.staff for each row execute function public.ensure_default_staff_permissions();

insert into public.staff_permissions(staff_id,permission,allowed)
select s.id, p.permission, true
from public.staff s cross join unnest(array['VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS','BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','ANALYTICS','SETTINGS','MENU_MANAGEMENT','BRANCH_MANAGEMENT','SUBSCRIPTION_MANAGEMENT']::text[]) p(permission)
where not exists(select 1 from public.staff_permissions sp where sp.staff_id=s.id and sp.permission=p.permission);

-- Replace base branch write policy with explicit branch-management entitlement/owner guard.
drop policy if exists branches_insert_owner on public.branches;
create policy branches_insert_owner on public.branches for insert to authenticated
with check (
  public.is_org_owner(organization_id)
  and public.organization_has_feature(organization_id,'MULTI_BRANCH')
);
drop policy if exists branches_update_owner on public.branches;
create policy branches_update_owner on public.branches for update to authenticated
using(public.is_org_owner(organization_id)) with check(public.is_org_owner(organization_id));
drop policy if exists branches_delete_owner on public.branches;
create policy branches_delete_owner on public.branches for delete to authenticated using(public.is_org_owner(organization_id));

-- Staff permission records are owner-managed and organization-scoped.
drop policy if exists staff_permissions_select on public.staff_permissions;
create policy staff_permissions_select on public.staff_permissions for select to authenticated using (
  exists(select 1 from public.staff target where target.id=staff_permissions.staff_id and public.is_org_member(target.organization_id))
);
drop policy if exists staff_permissions_write on public.staff_permissions;
create policy staff_permissions_write on public.staff_permissions for all to authenticated using (
  public.can_manage_permissions(staff_permissions.staff_id)
) with check (
  public.can_manage_permissions(staff_permissions.staff_id)
);
grant select,insert,update,delete on public.staff_permissions to authenticated;

drop policy if exists organization_domains_select on public.organization_domains;
create policy organization_domains_select on public.organization_domains for select to authenticated using(public.is_org_member(organization_id));
drop policy if exists organization_domains_write on public.organization_domains;
create policy organization_domains_write on public.organization_domains for all to authenticated using(public.is_org_owner(organization_id)) with check(public.is_org_owner(organization_id));
grant select,insert,update,delete on public.organization_domains to authenticated;

drop trigger if exists organization_domains_updated_at on public.organization_domains;
create trigger organization_domains_updated_at before update on public.organization_domains for each row execute function public.set_updated_at();


create or replace function public.create_organization_branch(p_name text,p_address text default null,p_phone text default null)
returns public.branches language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_limit integer; v_count integer; v_branch public.branches;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.role='OWNER' and s.active limit 1;
  if v_org is null then raise exception 'Only the organization owner can create branches' using errcode='42501'; end if;
  if not public.organization_has_feature(v_org,'MULTI_BRANCH') then raise exception 'Multi-branch management is not available on the current Tablely plan' using errcode='42501'; end if;
  select coalesce(limits->>'max_branches','0')::int into v_limit from public.get_current_entitlements();
  select count(*) into v_count from public.branches where organization_id=v_org;
  if v_limit >= 0 and v_count >= v_limit then raise exception 'Your current plan has reached its branch limit' using errcode='42501'; end if;
  insert into public.branches(organization_id,name,address,phone) values(v_org,left(trim(p_name),100),nullif(left(trim(coalesce(p_address,'')),300),''),nullif(left(trim(coalesce(p_phone,'')),30),'')) returning * into v_branch;
  return v_branch;
end; $$;
grant execute on function public.create_organization_branch(text,text,text) to authenticated;

create or replace function public.get_build12_analytics(p_branch_id uuid,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_org uuid; v_result jsonb;
begin
  select organization_id into v_org from public.branches where id=p_branch_id and is_active;
  if v_org is null or not public.is_branch_member(p_branch_id) then raise exception 'Not authorized' using errcode='42501'; end if;
  if not public.organization_has_feature(v_org,'ADVANCED_ANALYTICS') then raise exception 'Advanced analytics are not available on the current Tablely plan' using errcode='42501'; end if;
  with scoped as (
    select o.* from public.orders o where o.branch_id=p_branch_id and o.created_at>=p_from and o.created_at<p_to
  ), item_rank as (
    select oi.item_name_snapshot name, sum(oi.quantity)::int quantity, sum(oi.line_total)::numeric revenue
    from public.order_items oi join scoped s on s.id=oi.order_id group by oi.item_name_snapshot order by revenue desc limit 10
  ), peak as (
    select extract(hour from created_at)::int as hour, count(*)::int as orders, coalesce(sum(total) filter(where payment_status='PAID'),0)::numeric as revenue
    from scoped group by 1 order by orders desc limit 8
  ), prep as (
    select avg(extract(epoch from (coalesce(rr.ready_at,c.completed_at)-r.created_at))/60.0) avg_minutes
    from (select order_id,min(created_at) created_at from public.order_events where branch_id=p_branch_id and event_type='STATUS' and to_status='ACCEPTED' group by order_id) r
    left join lateral(select min(oe.created_at) ready_at from public.order_events oe where oe.order_id=r.order_id and oe.to_status='READY') rr on true
    left join lateral(select min(oe.created_at) completed_at from public.order_events oe where oe.order_id=r.order_id and oe.to_status='COMPLETED') c on true
  ), service as (
    select avg(extract(epoch from (resolved_at-created_at))/60.0) avg_minutes
    from public.service_requests where branch_id=p_branch_id and created_at>=p_from and created_at<p_to and resolved_at is not null
  ), table_usage as (
    select count(distinct table_id)::int used_tables, (select count(*) from public.tables where branch_id=p_branch_id and active)::int total_tables from scoped
  )
  select jsonb_build_object(
    'peak_hours',coalesce((select jsonb_agg(to_jsonb(peak) order by orders desc) from peak),'[]'::jsonb),
    'top_products',coalesce((select jsonb_agg(to_jsonb(item_rank) order by revenue desc) from item_rank),'[]'::jsonb),
    'cancellation_rate',coalesce((select round(count(*) filter(where status='CANCELLED')::numeric/nullif(count(*),0)*100,2) from scoped),0),
    'average_preparation_minutes',coalesce((select round(avg_minutes::numeric,1) from prep),0),
    'average_service_response_minutes',coalesce((select round(avg_minutes::numeric,1) from service),0),
    'table_utilization_percent',coalesce((select round(used_tables::numeric/nullif(total_tables,0)*100,1) from table_usage),0),
    'used_tables',coalesce((select used_tables from table_usage),0),
    'total_tables',coalesce((select total_tables from table_usage),0),
    'revenue',coalesce((select sum(total) from scoped where payment_status='PAID'),0),
    'orders',coalesce((select count(*) from scoped),0)
  ) into v_result;
  return v_result;
end; $$;
grant execute on function public.get_build12_analytics(uuid,timestamptz,timestamptz) to authenticated;

create or replace function public.get_build12_cross_branch_analytics(p_from timestamptz,p_to timestamptz)
returns table(branch_id uuid,branch_name text,revenue numeric,orders bigint,average_order_value numeric,cancelled bigint)
language plpgsql stable security definer set search_path=public as $$
begin
  if not exists(select 1 from public.staff s where s.user_id=auth.uid() and s.role='OWNER' and s.active) then raise exception 'Only the owner can view cross-branch reporting' using errcode='42501'; end if;
  return query select b.id,b.name,
    coalesce(sum(o.total) filter(where o.payment_status='PAID'),0),count(o.id),coalesce(avg(o.total),0),count(o.id) filter(where o.status='CANCELLED')
    from public.branches b left join public.orders o on o.branch_id=b.id and o.created_at>=p_from and o.created_at<p_to
    where b.organization_id=(select organization_id from public.staff where user_id=auth.uid() and role='OWNER' and active order by created_at limit 1)
    group by b.id,b.name order by revenue desc;
end; $$;
grant execute on function public.get_build12_cross_branch_analytics(timestamptz,timestamptz) to authenticated;

create or replace function public.set_staff_permission(p_staff_id uuid,p_permission text,p_allowed boolean)
returns public.staff_permissions language plpgsql security definer set search_path=public as $$
declare v_row public.staff_permissions; v_permission text:=upper(trim(p_permission));
begin
  if not public.can_manage_permissions(p_staff_id) then raise exception 'Only the owner can manage advanced permissions' using errcode='42501'; end if;
  if v_permission not in ('VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS','BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','ANALYTICS','SETTINGS','MENU_MANAGEMENT','BRANCH_MANAGEMENT','SUBSCRIPTION_MANAGEMENT') then raise exception 'Unsupported permission'; end if;
  insert into public.staff_permissions(staff_id,permission,allowed) values(p_staff_id,v_permission,p_allowed)
  on conflict(staff_id,permission) do update set allowed=excluded.allowed,updated_at=now() returning * into v_row;
  return v_row;
end; $$;
grant execute on function public.set_staff_permission(uuid,text,boolean) to authenticated;

create or replace function public.get_brand_profile(p_org_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('name',o.name,'slug',o.slug,'logo_url',o.brand_logo_url,'primary_color',o.brand_primary_color,'secondary_color',o.brand_secondary_color,'accent_color',o.brand_accent_color,'customer_theme',o.customer_theme,'menu_header',o.brand_menu_header)
 from public.organizations o where o.id=p_org_id and public.is_org_member(o.id);
$$;
grant execute on function public.get_brand_profile(uuid) to authenticated;

select pg_notify('pgrst','reload schema');

create or replace function public.get_public_brand_profile(p_table_code text)
returns table(logo_url text,primary_color text,secondary_color text,accent_color text,customer_theme text,menu_header text)
language sql stable security definer set search_path=public as $$
  select o.brand_logo_url,o.brand_primary_color,o.brand_secondary_color,o.brand_accent_color,o.customer_theme,o.brand_menu_header
  from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id
  where t.table_code=trim(p_table_code) and t.active and b.is_active and o.status='ACTIVE'::public.account_status limit 1;
$$;
grant execute on function public.get_public_brand_profile(text) to anon,authenticated;
select pg_notify('pgrst','reload schema');

create or replace function public.can_manage_permissions(p_staff_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.staff target
    join public.staff caller on caller.organization_id=target.organization_id
    where target.id=p_staff_id and caller.user_id=auth.uid() and caller.active and caller.role='OWNER'
  );
$$;
grant execute on function public.can_manage_permissions(uuid) to authenticated;

create or replace function public.update_build12_branding(
  p_org_id uuid,p_logo_url text,p_primary_color text,p_secondary_color text,p_accent_color text,p_customer_theme text,p_menu_header text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_row public.organizations;
begin
  if not public.is_org_owner(p_org_id) then raise exception 'Only the organization owner can update branding' using errcode='42501'; end if;
  if not public.organization_has_feature(p_org_id,'CUSTOM_BRANDING') then raise exception 'Custom branding is not available on the current Tablely plan' using errcode='42501'; end if;
  if p_primary_color !~ '^#[0-9A-Fa-f]{6}$' or p_secondary_color !~ '^#[0-9A-Fa-f]{6}$' or p_accent_color !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'Colors must be six-digit hex values'; end if;
  if p_customer_theme not in ('minimal','warm','bold') then raise exception 'Unsupported customer theme'; end if;
  update public.organizations set brand_logo_url=nullif(left(trim(coalesce(p_logo_url,'')),500),''),brand_primary_color=lower(p_primary_color),brand_secondary_color=lower(p_secondary_color),brand_accent_color=lower(p_accent_color),customer_theme=p_customer_theme,brand_menu_header=nullif(left(trim(coalesce(p_menu_header,'')),140),'') where id=p_org_id returning * into v_row;
  return jsonb_build_object('id',v_row.id,'updated_at',v_row.updated_at);
end; $$;
grant execute on function public.update_build12_branding(uuid,text,text,text,text,text,text) to authenticated;

create or replace function public.create_organization_domain(p_org_id uuid,p_hostname text)
returns public.organization_domains language plpgsql security definer set search_path=public as $$
declare v_row public.organization_domains; v_host text:=lower(trim(p_hostname));
begin
  if not public.is_org_owner(p_org_id) then raise exception 'Only the organization owner can add domains' using errcode='42501'; end if;
  if not public.organization_has_feature(p_org_id,'CUSTOM_DOMAIN') then raise exception 'Custom domains are not available on the current Tablely plan' using errcode='42501'; end if;
  if v_host !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then raise exception 'Invalid hostname'; end if;
  insert into public.organization_domains(organization_id,hostname) values(p_org_id,v_host) returning * into v_row;
  return v_row;
end; $$;
grant execute on function public.create_organization_domain(uuid,text) to authenticated;

create or replace function public.update_branch_settings(p_branch_id uuid,p_name text,p_address text,p_phone text,p_is_active boolean default true)
returns public.branches language plpgsql security definer set search_path=public as $$
declare v_row public.branches; v_org uuid;
begin
  select organization_id into v_org from public.branches where id=p_branch_id;
  if v_org is null or not public.is_org_owner(v_org) then raise exception 'Only the organization owner can manage branches' using errcode='42501'; end if;
  if not public.organization_has_feature(v_org,'MULTI_BRANCH') then raise exception 'Multi-branch management is not available on the current Tablely plan' using errcode='42501'; end if;
  if p_is_active=false and (select count(*) from public.branches where organization_id=v_org and is_active)>1 and (select is_active from public.branches where id=p_branch_id) then null; elsif p_is_active=false then raise exception 'At least one active branch is required'; end if;
  update public.branches set name=left(trim(p_name),100),address=nullif(left(trim(coalesce(p_address,'')),300),''),phone=nullif(left(trim(coalesce(p_phone,'')),30),''),is_active=p_is_active where id=p_branch_id returning * into v_row;
  return v_row;
end; $$;
grant execute on function public.update_branch_settings(uuid,text,text,text,boolean) to authenticated;

create or replace function public.get_organization_slug_by_domain(p_hostname text)
returns text language sql stable security definer set search_path=public as $$
  select o.slug from public.organization_domains d join public.organizations o on o.id=d.organization_id where d.hostname=lower(trim(p_hostname)) and d.status='VERIFIED' and o.status='ACTIVE'::public.account_status limit 1;
$$;
grant execute on function public.get_organization_slug_by_domain(text) to anon,authenticated;

create or replace function public.mark_domain_verified(p_domain_id uuid)
returns public.organization_domains language plpgsql security definer set search_path=public as $$
declare v_row public.organization_domains;
begin
  update public.organization_domains d set status='VERIFIED',verified_at=now(),updated_at=now()
  where d.id=p_domain_id and public.is_org_owner(d.organization_id)
  returning d.* into v_row;
  if v_row.id is null then raise exception 'Domain not found or not owned by current user' using errcode='42501'; end if;
  return v_row;
end; $$;
grant execute on function public.mark_domain_verified(uuid) to authenticated;

-- Cross-branch reporting is separately gated from single-branch advanced analytics.
create or replace function public.get_build12_cross_branch_analytics(p_from timestamptz,p_to timestamptz)
returns table(branch_id uuid,branch_name text,revenue numeric,orders bigint,average_order_value numeric,cancelled bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.staff where user_id=auth.uid() and role='OWNER' and active order by created_at limit 1;
  if v_org is null then raise exception 'Only the owner can view cross-branch reporting' using errcode='42501'; end if;
  if not public.organization_has_feature(v_org,'CROSS_BRANCH_REPORTING') then raise exception 'Cross-branch reporting is not available on the current Tablely plan' using errcode='42501'; end if;
  return query select b.id,b.name,
    coalesce(sum(o.total) filter(where o.payment_status='PAID'),0),count(o.id),coalesce(avg(o.total),0),count(o.id) filter(where o.status='CANCELLED')
    from public.branches b left join public.orders o on o.branch_id=b.id and o.created_at>=p_from and o.created_at<p_to
    where b.organization_id=v_org group by b.id,b.name order by revenue desc;
end; $$;
grant execute on function public.get_build12_cross_branch_analytics(timestamptz,timestamptz) to authenticated;
