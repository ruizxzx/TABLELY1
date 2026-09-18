begin;

create table if not exists public.restaurant_reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  customer_profile_id uuid not null references public.customer_profiles(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists restaurant_reviews_branch_created_idx
  on public.restaurant_reviews(branch_id, created_at desc);

alter table public.restaurant_reviews enable row level security;
revoke all on public.restaurant_reviews from anon, public;
grant select on public.restaurant_reviews to authenticated;

drop policy if exists restaurant_reviews_select_branch_member on public.restaurant_reviews;
create policy restaurant_reviews_select_branch_member on public.restaurant_reviews
  for select to authenticated using (public.is_branch_member(branch_id));

create or replace function public.submit_customer_review(
  p_order_id uuid,
  p_rating integer,
  p_comment text default null
)
returns public.restaurant_reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile uuid := public.build22_current_customer_profile();
  v_order public.orders%rowtype;
  v_review public.restaurant_reviews%rowtype;
begin
  if v_profile is null then
    raise exception 'Customer account required' using errcode = '42501';
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5' using errcode = '22023';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
    and customer_profile_id = v_profile
  for update;
  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.status::text not in ('SERVED', 'COMPLETED') or v_order.payment_status::text <> 'PAID' then
    raise exception 'Only served or completed paid orders can be reviewed' using errcode = '42501';
  end if;
  if exists (select 1 from public.restaurant_reviews where order_id = v_order.id) then
    raise exception 'This order has already been reviewed' using errcode = '23505';
  end if;

  insert into public.restaurant_reviews(order_id, branch_id, customer_profile_id, rating, comment)
  values (v_order.id, v_order.branch_id, v_profile, p_rating,
          nullif(left(trim(coalesce(p_comment, '')), 1000), ''))
  returning * into v_review;
  return v_review;
end;
$$;

revoke execute on function public.submit_customer_review(uuid, integer, text) from anon, public;
grant execute on function public.submit_customer_review(uuid, integer, text) to authenticated;

create or replace function public.get_my_customer_order_detail(p_order_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'order_id', o.id,
    'order_number', o.order_number,
    'restaurant_name', org.name,
    'branch_name', b.name,
    'created_at', o.created_at,
    'status', o.status,
    'payment_status', o.payment_status,
    'payment_method', o.payment_method,
    'total', o.total,
    'review', (select jsonb_build_object('id', r.id, 'rating', r.rating, 'comment', r.comment, 'created_at', r.created_at)
               from public.restaurant_reviews r where r.order_id = o.id),
    'items', coalesce((
      select jsonb_agg(to_jsonb(oi) order by oi.id)
      from public.order_items oi
      where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  join public.branches b on b.id = o.branch_id
  join public.organizations org on org.id = b.organization_id
  join public.customer_profiles cp on cp.id = o.customer_profile_id and cp.auth_user_id = auth.uid()
  where o.id = p_order_id;
$$;

revoke execute on function public.get_my_customer_order_detail(uuid) from anon, public;
grant execute on function public.get_my_customer_order_detail(uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
