create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);

alter table devices
  alter column owner_user_id type uuid using owner_user_id::uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'devices_owner_user_id_fkey'
  ) then
    alter table devices
      add constraint devices_owner_user_id_fkey
      foreign key (owner_user_id)
      references auth.users(id)
      on delete set null;
  end if;
end $$;

create table if not exists device_claim_codes (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null unique references devices(id) on delete cascade,
  claim_code text not null unique,
  expires_at timestamptz,
  claimed_at timestamptz,
  claimed_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists device_ownership_history (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  claimed_at timestamptz not null default now()
);

create index if not exists device_claim_codes_claimed_by_user_id_idx
  on device_claim_codes(claimed_by_user_id);

create index if not exists device_ownership_history_device_id_idx
  on device_ownership_history(device_id, claimed_at desc);

create index if not exists device_ownership_history_user_id_idx
  on device_ownership_history(user_id, claimed_at desc);

create or replace function claim_device(p_claim_code text, p_user_id uuid)
returns table (
  device_uid text,
  display_name text,
  group_slug text
)
language plpgsql
security definer
as $$
declare
  v_device_id uuid;
begin
  select d.id
  into v_device_id
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

  return query
  select d.device_uid, d.display_name, g.slug
  from devices d
  join app_groups g on g.id = d.group_id
  where d.id = v_device_id;
end;
$$;

comment on function claim_device(text, uuid) is
'Claims a device by one-time claim code and binds it to a Supabase auth user.';

