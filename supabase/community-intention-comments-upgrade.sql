create table if not exists community_intention_comments (
  id uuid primary key default gen_random_uuid(),
  intention_id uuid not null references community_intentions(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists community_intention_comments_intention_id_created_at_idx
  on community_intention_comments(intention_id, created_at asc);

create index if not exists community_intention_comments_user_id_idx
  on community_intention_comments(created_by_user_id, created_at desc);

alter table community_intention_comments enable row level security;
