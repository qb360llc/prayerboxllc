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

