alter table daily_reading_reminders
  add column if not exists next_trigger_at timestamptz;

create index if not exists daily_reading_reminders_next_trigger_at_idx
  on daily_reading_reminders(next_trigger_at);

update daily_reading_reminders
set
  next_trigger_at = case
    when (
      (
        date_trunc('day', now() at time zone timezone) + reminder_time
      ) at time zone timezone
    ) > now()
      then (
        (
          date_trunc('day', now() at time zone timezone) + reminder_time
        ) at time zone timezone
      )
    else (
      (
        date_trunc('day', (now() at time zone timezone) + interval '1 day') + reminder_time
      ) at time zone timezone
    )
  end
where next_trigger_at is null;
