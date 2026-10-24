begin;

create sequence if not exists public.support_ticket_number_seq;
grant usage, select on sequence public.support_ticket_number_seq to service_role;

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number text not null unique default (
    'TBL-SUP-' || to_char(now(), 'YYYY') || '-' ||
    lpad(nextval('public.support_ticket_number_seq')::text, 6, '0')
  ),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  category text not null check (category in (
    'TECHNICAL', 'QR_MENU', 'PAYMENTS', 'BILLING', 'SUBSCRIPTION',
    'BRANCH', 'STAFF_PERMISSIONS', 'WHATSAPP', 'GOOGLE_REVIEWS',
    'GENERAL', 'FEATURE_REQUEST'
  )),
  subject text not null check (char_length(subject) between 3 and 160),
  description text not null check (char_length(description) between 1 and 10000),
  priority text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  status text not null default 'NEW' check (status in (
    'NEW', 'OPEN', 'WAITING_FOR_RESTAURANT', 'ESCALATED', 'RESOLVED', 'CLOSED'
  )),
  assigned_to uuid references auth.users(id) on delete set null,
  last_message_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_tickets_org_recent_idx
  on public.support_tickets (organization_id, updated_at desc);
create index if not exists support_tickets_branch_recent_idx
  on public.support_tickets (branch_id, updated_at desc);
create index if not exists support_tickets_inbox_idx
  on public.support_tickets (status, priority, updated_at desc);
create index if not exists support_tickets_assignee_idx
  on public.support_tickets (assigned_to, status, updated_at desc);

create table if not exists public.support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  author_type text not null check (author_type in ('RESTAURANT', 'PLATFORM')),
  author_user_id uuid not null references auth.users(id) on delete restrict,
  body text not null check (char_length(body) between 1 and 10000),
  created_at timestamptz not null default now()
);
create index if not exists support_ticket_messages_thread_idx
  on public.support_ticket_messages (ticket_id, created_at, id);

create table if not exists public.support_internal_notes (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete restrict,
  body text not null check (char_length(body) between 1 and 10000),
  created_at timestamptz not null default now()
);
create index if not exists support_internal_notes_thread_idx
  on public.support_internal_notes (ticket_id, created_at, id);

create table if not exists public.support_audit_logs (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists support_audit_logs_thread_idx
  on public.support_audit_logs (ticket_id, created_at, id);

create or replace function public.log_support_ticket_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.support_audit_logs(ticket_id, actor_user_id, action, details)
  values (new.id, new.created_by, 'TICKET_CREATED',
    jsonb_build_object('ticket_number', new.ticket_number, 'category', new.category));
  return new;
end;
$$;

create or replace function public.log_support_ticket_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status then
    insert into public.support_audit_logs(ticket_id, actor_user_id, action, details)
    values (new.id, new.updated_by, 'STATUS_CHANGED', jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if old.priority is distinct from new.priority then
    insert into public.support_audit_logs(ticket_id, actor_user_id, action, details)
    values (new.id, new.updated_by, 'PRIORITY_CHANGED', jsonb_build_object('from', old.priority, 'to', new.priority));
  end if;
  if old.assigned_to is distinct from new.assigned_to then
    insert into public.support_audit_logs(ticket_id, actor_user_id, action, details)
    values (new.id, new.updated_by, 'ASSIGNMENT_CHANGED', jsonb_build_object('from', old.assigned_to, 'to', new.assigned_to));
  end if;
  return new;
end;
$$;

create or replace function public.log_support_ticket_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.support_tickets
  set last_message_at = new.created_at, updated_at = new.created_at
  where id = new.ticket_id;
  insert into public.support_audit_logs(ticket_id, actor_user_id, action, details)
  values (new.ticket_id, new.author_user_id, 'MESSAGE_SENT',
    jsonb_build_object('message_id', new.id, 'author_type', new.author_type));
  return new;
end;
$$;

create or replace function public.log_support_internal_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.support_audit_logs(ticket_id, actor_user_id, action, details)
  values (new.ticket_id, new.author_user_id, 'INTERNAL_NOTE_ADDED',
    jsonb_build_object('note_id', new.id));
  return new;
end;
$$;

drop trigger if exists support_ticket_created_audit on public.support_tickets;
create trigger support_ticket_created_audit after insert on public.support_tickets
for each row execute function public.log_support_ticket_created();
drop trigger if exists support_ticket_changed_audit on public.support_tickets;
create trigger support_ticket_changed_audit after update of status, priority, assigned_to on public.support_tickets
for each row execute function public.log_support_ticket_change();
drop trigger if exists support_ticket_message_audit on public.support_ticket_messages;
create trigger support_ticket_message_audit after insert on public.support_ticket_messages
for each row execute function public.log_support_ticket_message();
drop trigger if exists support_internal_note_audit on public.support_internal_notes;
create trigger support_internal_note_audit after insert on public.support_internal_notes
for each row execute function public.log_support_internal_note();

create or replace function public.create_restaurant_support_ticket(
  p_organization_id uuid,
  p_branch_id uuid,
  p_created_by uuid,
  p_category text,
  p_subject text,
  p_description text
)
returns public.support_tickets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.support_tickets;
begin
  insert into public.support_tickets(
    organization_id, branch_id, created_by, category, subject, description
  )
  values (
    p_organization_id, p_branch_id, p_created_by, p_category, p_subject, p_description
  )
  returning * into v_ticket;

  insert into public.support_ticket_messages(ticket_id, author_type, author_user_id, body)
  values (v_ticket.id, 'RESTAURANT', p_created_by, p_description);

  return v_ticket;
end;
$$;

revoke all on function public.create_restaurant_support_ticket(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_restaurant_support_ticket(uuid, uuid, uuid, text, text, text)
  to service_role;

do $$
declare
  t text;
begin
  foreach t in array array[
    'support_tickets', 'support_ticket_messages',
    'support_internal_notes', 'support_audit_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated, public', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

revoke all on function public.log_support_ticket_created() from public, anon, authenticated;
revoke all on function public.log_support_ticket_change() from public, anon, authenticated;
revoke all on function public.log_support_ticket_message() from public, anon, authenticated;
revoke all on function public.log_support_internal_note() from public, anon, authenticated;

commit;
