-- TABLELY BUILD 20.2/20.3 — SESSION CONTINUITY
--
-- A settled session can still receive another order when its visit token is
-- reused. Do not auto-close a recent token-backed session merely because a
-- different visit created a new session on the same table. The client visit
-- lifecycle is four hours, so the server uses the same interval as the
-- safety window before automatic closure.

begin;

create or replace function public.build20_auto_close_settled_sessions(
  p_table_id uuid,
  p_new_session_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select ts.id
    from public.table_sessions ts
    where ts.table_id = p_table_id
      and ts.status in ('ACTIVE','SETTLING')
      and ts.id <> p_new_session_id
      and (
        ts.session_token_hash is null
        or ts.last_seen_at <= now() - interval '4 hours'
      )
    order by ts.opened_at
  loop
    if public.build20_session_is_settled(r.id) then
      begin
        perform public.build20_close_session_core(r.id, null, 'AUTO_SETTLED_ON_NEW_VISIT');
      exception when others then
        -- Never let an auto-close race break the customer's own order or
        -- payment write. Worst case: the old session simply stays open and a
        -- manager closes it manually.
        null;
      end;
    end if;
  end loop;
end;
$$;

revoke execute on function public.build20_auto_close_settled_sessions(uuid, uuid) from anon, authenticated, public;

commit;

notify pgrst, 'reload schema';
