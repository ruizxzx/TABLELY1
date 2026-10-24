begin;

create table if not exists public.customer_restaurant_conversations (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  visit_token_hash text not null check (visit_token_hash ~ '^[0-9a-f]{64}$'),
  channel_key text not null unique default replace(gen_random_uuid()::text, '-', ''),
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED', 'CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create index if not exists customer_restaurant_conversations_branch_recent_idx
  on public.customer_restaurant_conversations (branch_id, last_message_at desc);
create index if not exists customer_restaurant_conversations_visit_idx
  on public.customer_restaurant_conversations (table_id, visit_token_hash, created_at desc);

create table if not exists public.customer_restaurant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.customer_restaurant_conversations(id) on delete cascade,
  client_message_id uuid not null,
  sender_type text not null check (sender_type in ('CUSTOMER', 'STAFF')),
  sender_user_id uuid references auth.users(id) on delete set null,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  unique (conversation_id, client_message_id)
);

create index if not exists customer_restaurant_messages_cursor_idx
  on public.customer_restaurant_messages (conversation_id, created_at, id);

alter table public.customer_restaurant_conversations enable row level security;
alter table public.customer_restaurant_messages enable row level security;
revoke all on public.customer_restaurant_conversations, public.customer_restaurant_messages
  from public, anon, authenticated;
grant all on public.customer_restaurant_conversations, public.customer_restaurant_messages
  to service_role;

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
      branch_id, table_id, visit_token_hash
    ) values (
      v_table.branch_id, v_table.id, p_visit_token_hash
    )
    returning * into v_conversation;
  end if;

  return query
    select v_conversation.id, v_conversation.branch_id, v_conversation.table_id,
      v_table.table_number, v_conversation.channel_key, v_conversation.status,
      v_conversation.expires_at;
end;
$$;

revoke all on function public.open_customer_restaurant_conversation(text, text)
  from public, anon, authenticated;
grant execute on function public.open_customer_restaurant_conversation(text, text)
  to service_role;

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
  select c.* into v_conversation
  from public.customer_restaurant_conversations as c
  where c.id = new.conversation_id;

  if v_conversation.id is null then
    return new;
  end if;

  update public.customer_restaurant_conversations
  set last_message_at = new.created_at, updated_at = new.created_at
  where id = v_conversation.id;

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

drop trigger if exists customer_restaurant_message_broadcast
  on public.customer_restaurant_messages;
create trigger customer_restaurant_message_broadcast
after insert on public.customer_restaurant_messages
for each row execute function public.broadcast_customer_restaurant_message();

create or replace function public.broadcast_customer_restaurant_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status then
    perform realtime.send(
      jsonb_build_object('conversation_id', new.id, 'status', new.status, 'updated_at', new.updated_at),
      'CONVERSATION_STATUS',
      'tablely:customer-conversation:' || new.channel_key,
      true
    );
    perform realtime.send(
      jsonb_build_object('conversation_id', new.id, 'status', new.status),
      'CONVERSATION_UPDATED',
      'tablely:customer-inbox:' || new.branch_id::text,
      true
    );
  end if;
  return new;
end;
$$;

drop trigger if exists customer_restaurant_status_broadcast
  on public.customer_restaurant_conversations;
create trigger customer_restaurant_status_broadcast
after update of status on public.customer_restaurant_conversations
for each row execute function public.broadcast_customer_restaurant_status();

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
      and c.expires_at > now()
  ) or exists (
    select 1
    from public.customer_restaurant_conversations as c
    where p_topic = 'tablely:customer-inbox:' || c.branch_id::text
      and exists (
        select 1
        from public.staff as s
        join public.branches as b on b.id = c.branch_id
        where s.user_id = auth.uid()
          and s.active = true
          and (
            s.branch_id = c.branch_id
            or (s.role = 'OWNER' and s.organization_id = b.organization_id)
          )
      )
  );
$$;
revoke all on function public.can_access_customer_chat_topic(text) from public;
grant execute on function public.can_access_customer_chat_topic(text) to anon, authenticated;

drop policy if exists customer_chat_private_topic_read on realtime.messages;
create policy customer_chat_private_topic_read on realtime.messages
for select to anon, authenticated
using (public.can_access_customer_chat_topic(realtime.topic()));

commit;
