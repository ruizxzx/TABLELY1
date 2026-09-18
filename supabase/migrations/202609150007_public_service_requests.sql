-- Public table-service request RPC and its rate-limit dependency.
create table if not exists public.rate_limit_buckets (
  key text primary key,
  window_started_at timestamptz not null,
  hit_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create or replace function public.allow_rate_limit(p_key text, p_window_seconds integer, p_max_requests integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_row public.rate_limit_buckets%rowtype;
  v_window interval := make_interval(secs => greatest(1, least(p_window_seconds, 3600)));
begin
  if coalesce(trim(p_key), '') = '' then
    raise exception 'Rate limit key required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(trim(p_key), 0));
  select * into v_row from public.rate_limit_buckets where key = trim(p_key) for update;

  if v_row.key is null or v_row.window_started_at + v_window <= v_now then
    insert into public.rate_limit_buckets(key, window_started_at, hit_count, updated_at)
    values (trim(p_key), v_now, 1, v_now)
    on conflict (key) do update set window_started_at = excluded.window_started_at, hit_count = 1, updated_at = v_now;
    return true;
  end if;
  if v_row.hit_count >= greatest(1, least(p_max_requests, 1000)) then
    return false;
  end if;
  update public.rate_limit_buckets set hit_count = hit_count + 1, updated_at = v_now where key = v_row.key;
  return true;
end;
$$;

grant execute on function public.allow_rate_limit(text, integer, integer) to anon, authenticated;

create or replace function public.create_service_request_for_table(
  p_table_code text,
  p_type text,
  p_note text default null
)
returns table (
  id uuid,
  branch_id uuid,
  table_id uuid,
  type text,
  status text,
  note text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table public.tables%rowtype;
  v_type text := upper(trim(coalesce(p_type, '')));
begin
  if not public.allow_rate_limit('service:' || trim(coalesce(p_table_code, '')), 60, 10) then
    raise exception 'Too many service requests. Please wait a moment.';
  end if;
  select t.* into v_table
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code)
    and t.active = true
    and o.status = 'ACTIVE'::public.account_status
  limit 1;
  if v_table.id is null then
    raise exception 'This table QR is invalid or inactive';
  end if;
  if v_type not in ('WAITER', 'WATER', 'BILL', 'ASSISTANCE') then
    raise exception 'Unsupported service request';
  end if;
  if exists (
    select 1 from public.service_requests r
    where r.table_id = v_table.id and r.type = v_type and r.status in ('OPEN', 'ACKNOWLEDGED')
  ) then
    raise exception 'This request is already open';
  end if;

  return query
  insert into public.service_requests(branch_id, table_id, type, status, note)
  values (v_table.branch_id, v_table.id, v_type, 'OPEN', nullif(left(trim(coalesce(p_note, '')), 300), ''))
  returning service_requests.id, service_requests.branch_id, service_requests.table_id,
            service_requests.type, service_requests.status, service_requests.note,
            service_requests.created_at;
end;
$$;

grant execute on function public.create_service_request_for_table(text, text, text) to anon, authenticated;
