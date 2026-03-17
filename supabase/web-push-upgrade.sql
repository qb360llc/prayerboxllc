create table if not exists web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh_key text not null,
  auth_key text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists web_push_subscriptions_user_id_idx
  on web_push_subscriptions(user_id, updated_at desc);

alter table web_push_subscriptions enable row level security;

alter table notifications
  drop constraint if exists notifications_notification_type_check;

alter table notifications
  add constraint notifications_notification_type_check check (
    notification_type in (
      'intention_posted',
      'intention_loved',
      'lights_activated',
      'chat_message'
    )
  );

drop policy if exists "web_push_subscriptions_select_self_or_admin" on web_push_subscriptions;
create policy "web_push_subscriptions_select_self_or_admin"
  on web_push_subscriptions
  for select
  to authenticated
  using (user_id = auth.uid() or current_user_is_admin());

drop policy if exists "web_push_subscriptions_insert_self_or_admin" on web_push_subscriptions;
create policy "web_push_subscriptions_insert_self_or_admin"
  on web_push_subscriptions
  for insert
  to authenticated
  with check (user_id = auth.uid() or current_user_is_admin());

drop policy if exists "web_push_subscriptions_update_self_or_admin" on web_push_subscriptions;
create policy "web_push_subscriptions_update_self_or_admin"
  on web_push_subscriptions
  for update
  to authenticated
  using (user_id = auth.uid() or current_user_is_admin())
  with check (user_id = auth.uid() or current_user_is_admin());

drop policy if exists "web_push_subscriptions_delete_self_or_admin" on web_push_subscriptions;
create policy "web_push_subscriptions_delete_self_or_admin"
  on web_push_subscriptions
  for delete
  to authenticated
  using (user_id = auth.uid() or current_user_is_admin());
