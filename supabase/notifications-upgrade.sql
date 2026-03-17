create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  group_id uuid references app_groups(id) on delete cascade,
  notification_type text not null check (
    notification_type in (
      'intention_posted',
      'intention_loved',
      'lights_activated',
      'daily_reading_uploaded'
    )
  ),
  title text not null,
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists notifications_recipient_created_at_idx
  on notifications(recipient_user_id, created_at desc);

create index if not exists notifications_recipient_read_at_idx
  on notifications(recipient_user_id, read_at, created_at desc);

alter table notifications enable row level security;

drop policy if exists "notifications_select_self_or_admin" on notifications;
create policy "notifications_select_self_or_admin"
  on notifications
  for select
  to authenticated
  using (recipient_user_id = auth.uid() or current_user_is_admin());

drop policy if exists "notifications_update_self_or_admin" on notifications;
create policy "notifications_update_self_or_admin"
  on notifications
  for update
  to authenticated
  using (recipient_user_id = auth.uid() or current_user_is_admin())
  with check (recipient_user_id = auth.uid() or current_user_is_admin());
