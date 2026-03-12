alter table if exists profiles
  add column if not exists is_admin boolean not null default false;

create table if not exists device_api_keys (
  device_id uuid primary key references devices(id) on delete cascade,
  key_hash text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists device_bootstrap_credentials (
  device_id uuid primary key references devices(id) on delete cascade,
  device_api_key text not null,
  claim_code text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  last_fetched_at timestamptz
);

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
alter table devices enable row level security;
alter table device_events enable row level security;
alter table device_claim_codes enable row level security;
alter table device_ownership_history enable row level security;
alter table firmware_releases enable row level security;
alter table device_firmware_status enable row level security;
alter table device_api_keys enable row level security;
alter table device_bootstrap_credentials enable row level security;

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

drop policy if exists "app_groups_select_authenticated" on app_groups;
create policy "app_groups_select_authenticated"
  on app_groups
  for select
  to authenticated
  using (true);

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

drop policy if exists "device_bootstrap_credentials_select_admin" on device_bootstrap_credentials;
create policy "device_bootstrap_credentials_select_admin"
  on device_bootstrap_credentials
  for select
  to authenticated
  using (current_user_is_admin());
