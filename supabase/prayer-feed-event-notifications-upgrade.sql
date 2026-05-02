alter table notifications
  drop constraint if exists notifications_notification_type_check;

alter table notifications
  add constraint notifications_notification_type_check check (
    notification_type in (
      'intention_posted',
      'intention_loved',
      'prayer_event_loved',
      'lights_activated',
      'chat_message',
      'daily_reading_uploaded',
      'daily_reading_reminder',
      'group_prayer_scheduled',
      'group_prayer_reminder'
    )
  );
