create table if not exists prayer_presence (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references app_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create index if not exists prayer_presence_group_started_idx
  on prayer_presence(group_id, started_at desc);

create table if not exists prayer_presence_events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references app_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('entered', 'left')),
  created_at timestamptz not null default now()
);

create index if not exists prayer_presence_events_group_created_idx
  on prayer_presence_events(group_id, created_at desc);

insert into prayer_presence (group_id, user_id, started_at)
select
  d.group_id,
  d.owner_user_id,
  coalesce(max(d.last_seen_at), now())
from devices d
where d.is_active = true
  and d.owner_user_id is not null
group by d.group_id, d.owner_user_id
on conflict (group_id, user_id) do nothing;

alter table prayer_presence enable row level security;
alter table prayer_presence_events enable row level security;
