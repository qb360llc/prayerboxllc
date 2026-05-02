create table if not exists prayer_feed_event_reactions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references app_groups(id) on delete cascade,
  event_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction_type text not null check (reaction_type in ('love')),
  created_at timestamptz not null default now(),
  unique (event_key, user_id, reaction_type)
);

create index if not exists prayer_feed_event_reactions_group_idx
  on prayer_feed_event_reactions(group_id, event_key, created_at desc);

create index if not exists prayer_feed_event_reactions_user_idx
  on prayer_feed_event_reactions(user_id, created_at desc);

alter table prayer_feed_event_reactions enable row level security;
