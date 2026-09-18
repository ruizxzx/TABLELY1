-- Store the storage object path separately from the public image URL.
alter table public.menu_items add column if not exists image_path text;
