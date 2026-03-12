alter table app_groups
  add column if not exists invite_code text;

alter table app_groups
  add column if not exists created_by_user_id uuid references auth.users(id) on delete set null;

update app_groups
set invite_code = 'PBXG-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
where invite_code is null;

alter table app_groups
  alter column invite_code set not null;

create unique index if not exists app_groups_invite_code_key on app_groups(invite_code);

create table if not exists group_memberships (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references app_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create index if not exists group_memberships_group_id_idx on group_memberships(group_id);
create index if not exists group_memberships_user_id_idx on group_memberships(user_id);

insert into group_memberships (group_id, user_id, role)
select distinct d.group_id, d.owner_user_id, 'member'
from devices d
where d.owner_user_id is not null
on conflict (group_id, user_id) do nothing;

insert into group_memberships (group_id, user_id, role)
select g.id, g.created_by_user_id, 'owner'
from app_groups g
where g.created_by_user_id is not null
on conflict (group_id, user_id) do update
set role = 'owner';

create or replace function current_user_is_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from group_memberships gm
    where gm.group_id = p_group_id
      and gm.user_id = auth.uid()
  );
$$;

create or replace function claim_device(p_claim_code text, p_user_id uuid)
returns table (
  device_uid text,
  display_name text,
  group_slug text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device_id uuid;
  v_group_id uuid;
begin
  select d.id, d.group_id
  into v_device_id, v_group_id
  from device_claim_codes c
  join devices d on d.id = c.device_id
  where c.claim_code = p_claim_code
    and c.claimed_at is null
    and (c.expires_at is null or c.expires_at > now());

  if v_device_id is null then
    raise exception 'Invalid or expired claim code';
  end if;

  update devices
  set owner_user_id = p_user_id
  where id = v_device_id;

  update device_claim_codes
  set claimed_at = now(),
      claimed_by_user_id = p_user_id
  where device_id = v_device_id;

  insert into device_ownership_history (device_id, user_id)
  values (v_device_id, p_user_id);

  insert into group_memberships (group_id, user_id, role)
  values (v_group_id, p_user_id, 'member')
  on conflict (group_id, user_id) do nothing;

  return query
  select d.device_uid, d.display_name, g.slug
  from devices d
  join app_groups g on g.id = d.group_id
  where d.id = v_device_id;
end;
$$;

alter table group_memberships enable row level security;

drop policy if exists "app_groups_select_authenticated" on app_groups;
drop policy if exists "app_groups_select_member_or_admin" on app_groups;
create policy "app_groups_select_member_or_admin"
  on app_groups
  for select
  to authenticated
  using (
    current_user_is_admin()
    or created_by_user_id = auth.uid()
    or current_user_is_group_member(id)
  );

drop policy if exists "group_memberships_select_member_or_admin" on group_memberships;
create policy "group_memberships_select_member_or_admin"
  on group_memberships
  for select
  to authenticated
  using (
    current_user_is_admin()
    or user_id = auth.uid()
    or current_user_is_group_member(group_id)
  );

drop policy if exists "group_memberships_insert_self_or_admin" on group_memberships;
create policy "group_memberships_insert_self_or_admin"
  on group_memberships
  for insert
  to authenticated
  with check (
    current_user_is_admin()
    or user_id = auth.uid()
  );

alter table daily_reading_recordings
  add column if not exists group_id uuid references app_groups(id) on delete cascade;

update daily_reading_recordings
set group_id = g.id
from app_groups g
where daily_reading_recordings.group_id is null
  and g.slug = 'main';

alter table daily_reading_recordings
  alter column group_id set not null;

create index if not exists daily_reading_recordings_group_id_idx
  on daily_reading_recordings(group_id, reading_date, created_at desc);
