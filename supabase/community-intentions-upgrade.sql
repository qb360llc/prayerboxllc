create table if not exists community_intentions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references app_groups(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists community_intentions_group_id_created_at_idx
  on community_intentions(group_id, created_at desc);

alter table community_intentions enable row level security;

create table if not exists community_intention_reactions (
  id uuid primary key default gen_random_uuid(),
  intention_id uuid not null references community_intentions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction_type text not null check (reaction_type in ('like', 'love')),
  created_at timestamptz not null default now(),
  unique (intention_id, user_id)
);

create index if not exists community_intention_reactions_intention_id_idx
  on community_intention_reactions(intention_id, created_at desc);

create index if not exists community_intention_reactions_user_id_idx
  on community_intention_reactions(user_id, created_at desc);

alter table community_intention_reactions enable row level security;
