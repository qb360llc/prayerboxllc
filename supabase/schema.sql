create extension if not exists pgcrypto;

create table if not exists app_groups (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  invite_code text not null unique,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  device_uid text not null unique,
  group_id uuid not null references app_groups(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  mqtt_username text,
  mqtt_password_hash text,
  is_active boolean not null default false,
  is_online boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists devices_group_id_idx on devices(group_id);
create index if not exists devices_owner_user_id_idx on devices(owner_user_id);

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

create table if not exists device_claim_codes (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null unique references devices(id) on delete cascade,
  claim_code text not null unique,
  expires_at timestamptz,
  claimed_at timestamptz,
  claimed_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists device_claim_codes_claimed_by_user_id_idx on device_claim_codes(claimed_by_user_id);

create table if not exists device_events (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists device_events_device_id_idx on device_events(device_id);
create index if not exists device_events_created_at_idx on device_events(created_at desc);

create table if not exists device_ownership_history (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  claimed_at timestamptz not null default now()
);

create index if not exists device_ownership_history_device_id_idx on device_ownership_history(device_id, claimed_at desc);
create index if not exists device_ownership_history_user_id_idx on device_ownership_history(user_id, claimed_at desc);

create or replace view group_activity as
select
  g.id as group_id,
  g.slug,
  count(*) filter (where d.is_active) as active_count,
  case
    when count(*) filter (where d.is_active) = 0 then 'off'
    when count(*) filter (where d.is_active) = 1 then 'solid'
    else 'flash'
  end as lighting_mode
from app_groups g
left join devices d on d.group_id = g.id
group by g.id, g.slug;

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

create table if not exists firmware_releases (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  version text not null,
  firmware_url text not null,
  checksum_sha256 text,
  notes text,
  min_device_prefix text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (channel, version)
);

create index if not exists firmware_releases_channel_active_idx
  on firmware_releases(channel, is_active, created_at desc);

create table if not exists device_firmware_status (
  device_id uuid primary key references devices(id) on delete cascade,
  current_version text,
  last_reported_at timestamptz not null default now(),
  last_manifest_check_at timestamptz,
  last_update_status text,
  last_update_error text
);

create table if not exists device_api_keys (
  device_id uuid primary key references devices(id) on delete cascade,
  key_hash text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  last_used_at timestamptz
);

create or replace view latest_firmware_releases as
select distinct on (channel)
  id,
  channel,
  version,
  firmware_url,
  checksum_sha256,
  notes,
  min_device_prefix,
  is_active,
  created_at
from firmware_releases
where is_active = true
order by channel, created_at desc;

create or replace function current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select p.is_admin
      from profiles p
      where p.id = auth.uid()
    ),
    false
  );
$$;

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

create or replace function handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do update
    set email = excluded.email;

  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'on_auth_user_created_profile'
  ) then
    create trigger on_auth_user_created_profile
      after insert on auth.users
      for each row execute function handle_new_user_profile();
  end if;
end;
$$;

alter table profiles enable row level security;
alter table app_groups enable row level security;
alter table group_memberships enable row level security;
alter table devices enable row level security;
alter table device_events enable row level security;
alter table device_claim_codes enable row level security;
alter table device_ownership_history enable row level security;
alter table firmware_releases enable row level security;
alter table device_firmware_status enable row level security;
alter table device_api_keys enable row level security;

drop policy if exists "profiles_select_self_or_admin" on profiles;
create policy "profiles_select_self_or_admin"
  on profiles
  for select
  to authenticated
  using (id = auth.uid() or current_user_is_admin());

drop policy if exists "profiles_update_self_or_admin" on profiles;
create policy "profiles_update_self_or_admin"
  on profiles
  for update
  to authenticated
  using (id = auth.uid() or current_user_is_admin())
  with check (id = auth.uid() or current_user_is_admin());

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

drop policy if exists "devices_select_owner_or_admin" on devices;
create policy "devices_select_owner_or_admin"
  on devices
  for select
  to authenticated
  using (owner_user_id = auth.uid() or current_user_is_admin());

drop policy if exists "device_events_select_owner_or_admin" on device_events;
create policy "device_events_select_owner_or_admin"
  on device_events
  for select
  to authenticated
  using (
    current_user_is_admin()
    or exists (
      select 1
      from devices d
      where d.id = device_events.device_id
        and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "device_claim_codes_select_admin" on device_claim_codes;
create policy "device_claim_codes_select_admin"
  on device_claim_codes
  for select
  to authenticated
  using (current_user_is_admin());

drop policy if exists "device_ownership_history_select_owner_or_admin" on device_ownership_history;
create policy "device_ownership_history_select_owner_or_admin"
  on device_ownership_history
  for select
  to authenticated
  using (user_id = auth.uid() or current_user_is_admin());

drop policy if exists "firmware_releases_select_authenticated" on firmware_releases;
create policy "firmware_releases_select_authenticated"
  on firmware_releases
  for select
  to authenticated
  using (true);

drop policy if exists "firmware_releases_admin_write" on firmware_releases;
create policy "firmware_releases_admin_write"
  on firmware_releases
  for all
  to authenticated
  using (current_user_is_admin())
  with check (current_user_is_admin());

drop policy if exists "device_firmware_status_select_owner_or_admin" on device_firmware_status;
create policy "device_firmware_status_select_owner_or_admin"
  on device_firmware_status
  for select
  to authenticated
  using (
    current_user_is_admin()
    or exists (
      select 1
      from devices d
      where d.id = device_firmware_status.device_id
        and d.owner_user_id = auth.uid()
    )
  );

drop policy if exists "device_api_keys_select_admin" on device_api_keys;
create policy "device_api_keys_select_admin"
  on device_api_keys
  for select
  to authenticated
  using (current_user_is_admin());
