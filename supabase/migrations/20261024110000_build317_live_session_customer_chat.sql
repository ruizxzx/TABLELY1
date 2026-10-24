begin;

alter table public.customer_restaurant_conversations
  add column if not exists table_session_id uuid references public.table_sessions(id) on delete set null,
  add column if not exists last_staff_read_at timestamptz not null default now(),
  add column if not exists unread_customer_count integer not null default 0
    check (unread_customer_count >= 0);

create index if not exists customer_restaurant_conversations_active_inbox_idx
  on public.customer_restaurant_conversations(branch_id, last_message_at desc)
  where status = 'OPEN';
create index if not exists customer_restaurant_messages_customer_unread_idx
  on public.customer_restaurant_messages(conversation_id, created_at desc)
  where sender_type = 'CUSTOMER';

create or replace function public.mark_customer_chat_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.customer_restaurant_conversations%rowtype;
begin
  update public.customer_restaurant_conversations
  set unread_customer_count = 0,
      last_staff_read_at = now()
  where id = p_conversation_id
    and status = 'OPEN'
  returning * into v_conversation;

  if v_conversation.id is null then
    raise exception 'Open customer conversation not found' using errcode = 'P0002';
  end if;

  perform realtime.send(
    jsonb_build_object('conversation_id', v_conversation.id),
    'READ_STATE_CHANGED',
    'tablely:customer-inbox:' || v_conversation.branch_id::text,
    true
  );
end;
$$;

revoke all on function public.mark_customer_chat_read(uuid) from public, anon, authenticated;
grant execute on function public.mark_customer_chat_read(uuid) to service_role;

update public.customer_restaurant_conversations c
set table_session_id = s.id
from public.table_sessions s
where c.table_session_id is null
  and c.table_id = s.table_id
  and c.visit_token_hash = s.session_token_hash
  and s.status in ('ACTIVE', 'SETTLING');

create or replace function public.broadcast_customer_restaurant_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.customer_restaurant_conversations%rowtype;
  v_payload jsonb;
begin
  update public.customer_restaurant_conversations
  set last_message_at = new.created_at,
      updated_at = new.created_at,
      unread_customer_count = case
        when new.sender_type = 'CUSTOMER' then unread_customer_count + 1
        else 0
      end,
      last_staff_read_at = case
        when new.sender_type = 'STAFF' then new.created_at
        else last_staff_read_at
      end
  where id = new.conversation_id
  returning * into v_conversation;

  if v_conversation.id is null then
    return new;
  end if;

  v_payload := jsonb_build_object(
    'id', new.id,
    'conversation_id', new.conversation_id,
    'client_message_id', new.client_message_id,
    'sender_type', new.sender_type,
    'body', new.body,
    'created_at', new.created_at
  );

  perform realtime.send(
    v_payload,
    'NEW_MESSAGE',
    'tablely:customer-conversation:' || v_conversation.channel_key,
    true
  );
  perform realtime.send(
    jsonb_build_object('conversation_id', new.conversation_id, 'sender_type', new.sender_type),
    'CONVERSATION_UPDATED',
    'tablely:customer-inbox:' || v_conversation.branch_id::text,
    true
  );
  return new;
end;
$$;

create or replace function public.open_customer_restaurant_conversation(
  p_table_code text,
  p_visit_token_hash text
)
returns table (
  id uuid,
  branch_id uuid,
  table_id uuid,
  table_number integer,
  channel_key text,
  status text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table public.tables%rowtype;
  v_session public.table_sessions%rowtype;
  v_conversation public.customer_restaurant_conversations%rowtype;
begin
  if p_table_code is null or length(p_table_code) > 64
     or p_visit_token_hash is null or p_visit_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid customer conversation context' using errcode = '22023';
  end if;

  select t.* into v_table
  from public.tables as t
  where t.table_code = p_table_code and t.active = true
  limit 1;
  if v_table.id is null then
    raise exception 'Table not found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_table.id::text || p_visit_token_hash, 0));

  select s.* into v_session
  from public.table_sessions as s
  where s.table_id = v_table.id
    and s.session_token_hash = p_visit_token_hash
  order by s.opened_at desc
  limit 1
  for update;

  if v_session.id is not null and v_session.status = 'CLOSED' then
    raise exception 'This table visit has ended. Start a new visit to contact the restaurant.'
      using errcode = 'P0001';
  end if;

  select c.* into v_conversation
  from public.customer_restaurant_conversations as c
  where c.table_id = v_table.id
    and c.visit_token_hash = p_visit_token_hash
    and c.status = 'OPEN'
    and c.expires_at > now()
  order by c.created_at desc
  limit 1;

  if v_conversation.id is null then
    insert into public.customer_restaurant_conversations (
      branch_id, table_id, visit_token_hash, table_session_id
    ) values (
      v_table.branch_id, v_table.id, p_visit_token_hash, v_session.id
    )
    returning * into v_conversation;
  elsif v_session.id is not null and v_conversation.table_session_id is null then
    update public.customer_restaurant_conversations
    set table_session_id = v_session.id, updated_at = now()
    where id = v_conversation.id
    returning * into v_conversation;
  end if;

  return query
    select v_conversation.id, v_conversation.branch_id, v_conversation.table_id,
      v_table.table_number, v_conversation.channel_key, v_conversation.status,
      v_conversation.expires_at;
end;
$$;

create or replace function public.link_customer_chat_to_order_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.table_sessions%rowtype;
begin
  if new.table_session_id is null then
    return new;
  end if;

  select s.* into v_session
  from public.table_sessions s
  where s.id = new.table_session_id
    and s.table_id = new.table_id
    and s.branch_id = new.branch_id
  for share;

  if v_session.id is null or v_session.session_token_hash is null then
    return new;
  end if;

  if v_session.status = 'CLOSED' then
    update public.customer_restaurant_conversations c
    set status = 'CLOSED', updated_at = now()
    where c.table_id = v_session.table_id
      and c.branch_id = v_session.branch_id
      and c.visit_token_hash = v_session.session_token_hash
      and c.status <> 'CLOSED';
    return new;
  end if;

  if v_session.status not in ('ACTIVE', 'SETTLING') then
    return new;
  end if;

  update public.customer_restaurant_conversations c
  set table_session_id = v_session.id,
      updated_at = now()
  where c.table_id = v_session.table_id
    and c.branch_id = v_session.branch_id
    and c.visit_token_hash = v_session.session_token_hash
    and c.table_session_id is null
    and c.status = 'OPEN';

  return new;
end;
$$;

drop trigger if exists link_customer_chat_to_order_session
  on public.orders;
create trigger link_customer_chat_to_order_session
after insert or update of table_session_id on public.orders
for each row execute function public.link_customer_chat_to_order_session();

create or replace function public.close_customer_chat_with_table_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status and new.status = 'CLOSED' then
    update public.customer_restaurant_conversations
    set status = 'CLOSED', updated_at = now()
    where table_session_id = new.id and status <> 'CLOSED';
  end if;
  return new;
end;
$$;

drop trigger if exists close_customer_chat_with_table_session
  on public.table_sessions;
create trigger close_customer_chat_with_table_session
after update of status on public.table_sessions
for each row execute function public.close_customer_chat_with_table_session();

create or replace function public.can_access_customer_chat_topic(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.customer_restaurant_conversations as c
    where p_topic = 'tablely:customer-conversation:' || c.channel_key
      and c.status = 'OPEN'
      and c.expires_at > now()
  ) or exists (
    select 1
    from public.staff as s
    join public.branches as b on b.id = s.branch_id or (s.role = 'OWNER' and b.organization_id = s.organization_id)
    where p_topic = 'tablely:customer-inbox:' || b.id::text
      and s.user_id = auth.uid()
      and s.active = true
      and s.role in ('OWNER', 'MANAGER', 'WAITER')
  );
$$;

commit;
