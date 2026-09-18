-- Storage for menu images. Public read is intentional because customer menus are anonymous.
insert into storage.buckets (id, name, public)
values ('menu-images', 'menu-images', true)
on conflict (id) do update set public = true;

drop policy if exists menu_images_insert_manager on storage.objects;
create policy menu_images_insert_manager on storage.objects
for insert to authenticated
with check (
  bucket_id = 'menu-images'
  and (storage.foldername(name))[1] is not null
  and public.is_branch_manager_or_owner(((storage.foldername(name))[1])::uuid)
);

drop policy if exists menu_images_update_manager on storage.objects;
create policy menu_images_update_manager on storage.objects
for update to authenticated
using (
  bucket_id = 'menu-images'
  and public.is_branch_manager_or_owner(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'menu-images'
  and public.is_branch_manager_or_owner(((storage.foldername(name))[1])::uuid)
);

drop policy if exists menu_images_delete_manager on storage.objects;
create policy menu_images_delete_manager on storage.objects
for delete to authenticated
using (
  bucket_id = 'menu-images'
  and public.is_branch_manager_or_owner(((storage.foldername(name))[1])::uuid)
);
