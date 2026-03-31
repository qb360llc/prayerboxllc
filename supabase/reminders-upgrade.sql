create table if not exists daily_reading_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid not null references app_groups(id) on delete cascade,
  reminder_time time not null,
  timezone text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, group_id)
);

create index if not exists daily_reading_reminders_group_id_idx
  on daily_reading_reminders(group_id, user_id);

create table if not exists group_prayer_schedules (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references app_groups(id) on delete cascade,
  created_by_user_id uuid not null references auth.users(id) on delete cascade,
  scheduled_for timestamptz not null,
  reminder_minutes integer not null default 15 check (reminder_minutes between 0 and 1440),
  timezone text not null,
  cancelled_at timestamptz,
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists group_prayer_schedules_group_id_idx
  on group_prayer_schedules(group_id, scheduled_for desc);

create index if not exists group_prayer_schedules_active_idx
  on group_prayer_schedules(group_id, cancelled_at, reminder_sent_at, scheduled_for);

create table if not exists reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  reminder_kind text not null check (reminder_kind in ('daily_reading', 'group_prayer')),
  reminder_key text not null,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  unique (reminder_kind, reminder_key, recipient_user_id)
);

create index if not exists reminder_deliveries_lookup_idx
  on reminder_deliveries(reminder_kind, reminder_key, recipient_user_id);

alter table daily_reading_reminders enable row level security;
alter table group_prayer_schedules enable row level security;
alter table reminder_deliveries enable row level security;

alter table notifications
  drop constraint if exists notifications_notification_type_check;

alter table notifications
  add constraint notifications_notification_type_check check (
    notification_type in (
      'intention_posted',
      'intention_loved',
      'lights_activated',
      'chat_message',
      'daily_reading_uploaded',
      'daily_reading_reminder',
      'group_prayer_scheduled',
      'group_prayer_reminder'
    )
  );
