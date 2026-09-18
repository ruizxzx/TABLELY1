-- Secure authenticated access for the service-requests workspace screen.
alter table public.service_requests enable row level security;
revoke all on public.service_requests from anon;

drop policy if exists service_requests_select_member on public.service_requests;
create policy service_requests_select_member on public.service_requests
for select to authenticated
using (public.is_branch_member(branch_id));

drop policy if exists service_requests_update_member on public.service_requests;
create policy service_requests_update_member on public.service_requests
for update to authenticated
using (public.is_branch_member(branch_id))
with check (public.is_branch_member(branch_id));

grant select, update on public.service_requests to authenticated;
