create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists reminder_job_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_source text not null default 'manual',
  window_minutes integer not null default 2 check (window_minutes >= 1 and window_minutes <= 60),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  daily_due_count integer not null default 0,
  daily_sent_count integer not null default 0,
  group_due_count integer not null default 0,
  group_sent_count integer not null default 0,
  error_text text
);

create index if not exists reminder_job_runs_started_at_idx
  on reminder_job_runs(started_at desc);

create table if not exists reminder_delivery_logs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references reminder_job_runs(id) on delete set null,
  reminder_kind text not null check (reminder_kind in ('daily_reading', 'group_prayer')),
  reminder_stage text not null check (reminder_stage in ('scheduled', 'pre', 'start')),
  reminder_key text not null,
  recipient_user_id uuid references auth.users(id) on delete set null,
  group_id uuid references app_groups(id) on delete set null,
  scheduled_for timestamptz,
  scheduled_local_date text,
  scheduled_local_time text,
  timezone text,
  processed_at timestamptz not null default now(),
  lateness_seconds integer not null default 0,
  title text,
  body text,
  trigger_source text not null default 'manual',
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists reminder_delivery_logs_processed_at_idx
  on reminder_delivery_logs(processed_at desc);

create index if not exists reminder_delivery_logs_kind_idx
  on reminder_delivery_logs(reminder_kind, reminder_stage, processed_at desc);

alter table reminder_job_runs enable row level security;
alter table reminder_delivery_logs enable row level security;

drop policy if exists "Admins can view reminder job runs" on reminder_job_runs;
create policy "Admins can view reminder job runs"
  on reminder_job_runs
  for select
  using (
    exists (
      select 1
      from profiles
      where profiles.id = auth.uid()
        and profiles.is_admin = true
    )
  );

drop policy if exists "Admins can view reminder delivery logs" on reminder_delivery_logs;
create policy "Admins can view reminder delivery logs"
  on reminder_delivery_logs
  for select
  using (
    exists (
      select 1
      from profiles
      where profiles.id = auth.uid()
        and profiles.is_admin = true
    )
  );

-- Store secrets in Vault. Replace the second value with your real reminder secret.
select vault.create_secret('https://qtvskyncpuznnzuptgoc.supabase.co', 'prayerbox_project_url')
where not exists (
  select 1 from vault.decrypted_secrets where name = 'prayerbox_project_url'
);

-- Replace YOUR_REAL_REMINDER_SECRET before running this statement.
-- If the secret already exists, use vault.update_secret(...) instead.
-- select vault.create_secret('YOUR_REAL_REMINDER_SECRET', 'prayerbox_reminder_secret')
-- where not exists (
--   select 1 from vault.decrypted_secrets where name = 'prayerbox_reminder_secret'
-- );

-- Remove any older copy of this cron job first.
select cron.unschedule(jobid)
from cron.job
where jobname = 'prayerbox-process-reminders';

-- Schedule the reminder processor every minute.
-- Uncomment after the prayerbox_reminder_secret Vault secret exists.
-- select cron.schedule(
--   'prayerbox-process-reminders',
--   '* * * * *',
--   $$
--   select
--     net.http_post(
--       url := (select decrypted_secret from vault.decrypted_secrets where name = 'prayerbox_project_url') || '/functions/v1/process-reminders',
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         'x-reminder-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'prayerbox_reminder_secret')
--       ),
--       body := jsonb_build_object(
--         'source', 'supabase_cron',
--         'triggeredAt', now()::text
--       )
--     ) as request_id;
--   $$
-- );

-- Helpful checks:
-- select * from cron.job where jobname = 'prayerbox-process-reminders';
-- select * from cron.job_run_details order by start_time desc limit 20;
-- select * from reminder_job_runs order by started_at desc limit 20;
-- select * from reminder_delivery_logs order by processed_at desc limit 50;
