insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'daily-readings-audio',
  'daily-readings-audio',
  false,
  52428800,
  array['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac']
)
on conflict (id) do nothing;

create table if not exists daily_reading_recordings (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references app_groups(id) on delete cascade,
  reading_date date not null,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  content_type text not null,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists daily_reading_recordings_reading_date_idx
  on daily_reading_recordings(reading_date, created_at desc);

create index if not exists daily_reading_recordings_group_id_idx
  on daily_reading_recordings(group_id, reading_date, created_at desc);

alter table daily_reading_recordings enable row level security;
