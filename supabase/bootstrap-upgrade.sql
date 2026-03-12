create table if not exists device_bootstrap_credentials (
  device_id uuid primary key references devices(id) on delete cascade,
  device_api_key text not null,
  claim_code text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  last_fetched_at timestamptz
);

alter table device_bootstrap_credentials enable row level security;

drop policy if exists "device_bootstrap_credentials_select_admin" on device_bootstrap_credentials;
create policy "device_bootstrap_credentials_select_admin"
  on device_bootstrap_credentials
  for select
  to authenticated
  using (current_user_is_admin());
