-- Restore the authenticated staff table privilege and tenant policies.
revoke all on public.staff from anon;
grant select, insert, update, delete on public.staff to authenticated;

alter table public.staff enable row level security;

drop policy if exists staff_select_member on public.staff;
create policy staff_select_member on public.staff
for select to authenticated
using (
  user_id = auth.uid()
  or public.is_org_owner(organization_id)
  or public.is_org_member(organization_id)
);

drop policy if exists staff_insert_owner on public.staff;
create policy staff_insert_owner on public.staff
for insert to authenticated
with check (public.is_org_owner(organization_id));

drop policy if exists staff_update_owner on public.staff;
create policy staff_update_owner on public.staff
for update to authenticated
using (public.is_org_owner(organization_id))
with check (public.is_org_owner(organization_id));

drop policy if exists staff_delete_owner on public.staff;
create policy staff_delete_owner on public.staff
for delete to authenticated
using (public.is_org_owner(organization_id));
