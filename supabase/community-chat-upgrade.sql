insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'community-chat-audio',
  'community-chat-audio',
  false,
  52428800,
  array['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac']
)
on conflict (id) do nothing;

create table if not exists community_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references app_groups(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  message_type text not null check (message_type in ('text', 'audio')),
  body text,
  storage_path text unique,
  content_type text,
  duration_ms integer,
  created_at timestamptz not null default now(),
  constraint community_messages_content_check check (
    (message_type = 'text' and body is not null and storage_path is null)
    or
    (message_type = 'audio' and storage_path is not null)
  )
);

create index if not exists community_messages_group_id_created_at_idx
  on community_messages(group_id, created_at asc);

create index if not exists community_messages_created_by_user_id_idx
  on community_messages(created_by_user_id, created_at desc);

alter table community_messages enable row level security;
