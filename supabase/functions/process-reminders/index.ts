import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPushToUsers } from "../_shared/web-push.ts";

type DailyReminderRow = {
  group_id: string;
  id: string;
  reminder_time: string;
  timezone: string;
  user_id: string;
};

type GroupRow = {
  id: string;
  name: string;
  slug: string;
};

type PrayerScheduleRow = {
  created_by_user_id?: string | null;
  group_id: string;
  id: string;
  reminder_minutes: number;
  scheduled_for: string;
  timezone: string;
};

function corsHeaders(request: Request) {
  const allowedOrigin = Deno.env.get("PRAYERBOX_PORTAL_ORIGIN");
  const requestOrigin = request.headers.get("Origin");
  const origin = allowedOrigin
    ? (requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin)
    : "*";

  return {
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey, x-reminder-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

function json(request: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
    },
    status,
  });
}

function buildHomeUrl(open?: "feed" | "chat" | "reading" | "schedule", groupSlug?: unknown) {
  const params = new URLSearchParams();
  if (open) {
    params.set("open", open);
  }
  if (typeof groupSlug === "string" && groupSlug.trim()) {
    params.set("group", groupSlug.trim());
  }
  const query = params.toString();
  return query ? `/home.html?${query}` : "/home.html";
}

function requireReminderSecret(request: Request) {
  const expected = Deno.env.get("PRAYERBOX_REMINDER_SECRET");
  if (!expected) {
    throw new Error("Missing PRAYERBOX_REMINDER_SECRET.");
  }

  const supplied = request.headers.get("x-reminder-secret")?.trim();
  if (!supplied || supplied !== expected) {
    return false;
  }

  return true;
}

function zonedParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  });

  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour || 0),
    minute: Number(values.minute || 0),
  };
}

function minutesSinceMidnight(hour: number, minute: number) {
  return (hour * 60) + minute;
}

function parseStoredTime(value: string) {
  const match = String(value).match(/^(\d{2}):(\d{2})/);
  if (!match) {
    throw new Error(`Invalid reminder time "${value}".`);
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

async function getSupabase() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

async function loadGroupsById(
  supabase: ReturnType<typeof createClient>,
  groupIds: string[],
) {
  if (!groupIds.length) {
    return new Map<string, GroupRow>();
  }

  const { data, error } = await supabase
    .from("app_groups")
    .select("id, slug, name")
    .in("id", groupIds);

  if (error) throw error;

  return new Map((data ?? []).map((group: Record<string, unknown>) => [
    String(group.id),
    {
      id: String(group.id),
      name: String(group.name || ""),
      slug: String(group.slug || ""),
    },
  ]));
}

async function deliveryExists(
  supabase: ReturnType<typeof createClient>,
  reminderKind: string,
  reminderKey: string,
  recipientUserId: string,
) {
  const { data, error } = await supabase
    .from("reminder_deliveries")
    .select("id")
    .eq("reminder_kind", reminderKind)
    .eq("reminder_key", reminderKey)
    .eq("recipient_user_id", recipientUserId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

async function storeDelivery(
  supabase: ReturnType<typeof createClient>,
  reminderKind: string,
  reminderKey: string,
  recipientUserId: string,
) {
  const { error } = await supabase
    .from("reminder_deliveries")
    .upsert({
      reminder_key: reminderKey,
      reminder_kind: reminderKind,
      recipient_user_id: recipientUserId,
    }, {
      ignoreDuplicates: true,
      onConflict: "reminder_kind,reminder_key,recipient_user_id",
    });

  if (error) throw error;
}

async function processDailyReadingReminders(
  supabase: ReturnType<typeof createClient>,
  now: Date,
  windowMinutes: number,
) {
  const { data, error } = await supabase
    .from("daily_reading_reminders")
    .select("id, user_id, group_id, reminder_time, timezone");

  if (error) throw error;

  const reminders = (data ?? []) as DailyReminderRow[];
  const groupsById = await loadGroupsById(
    supabase,
    Array.from(new Set(reminders.map((row) => row.group_id))),
  );

  let sent = 0;
  for (const reminder of reminders) {
    const group = groupsById.get(reminder.group_id);
    if (!group) continue;

    const local = zonedParts(now, reminder.timezone || "UTC");
    const reminderTime = parseStoredTime(reminder.reminder_time);
    const currentMinutes = minutesSinceMidnight(local.hour, local.minute);
    const reminderMinutes = minutesSinceMidnight(reminderTime.hour, reminderTime.minute);
    const due = currentMinutes >= reminderMinutes && currentMinutes < (reminderMinutes + windowMinutes);
    if (!due) continue;

    const reminderKey = `${reminder.id}:${local.date}`;
    if (await deliveryExists(supabase, "daily_reading", reminderKey, reminder.user_id)) {
      continue;
    }
    const title = "Daily reading reminder";
    const body = `Today's daily reading is ready${group.name ? ` for ${group.name}` : ""}.`;
    const metadata = {
      groupSlug: group.slug,
      reminderDate: local.date,
      source: "daily_reading_reminder",
    };

    const { error: insertError } = await supabase
      .from("notifications")
      .insert({
        body,
        group_id: group.id,
        metadata,
        notification_type: "daily_reading_reminder",
        recipient_user_id: reminder.user_id,
        title,
      });

    if (insertError) throw insertError;

    await sendPushToUsers(supabase, [reminder.user_id], {
      body,
      data: {
        groupId: group.id,
        type: "daily_reading_reminder",
        url: buildHomeUrl("reading", group.slug),
        ...metadata,
      },
      tag: `daily-reading-reminder-${reminder.user_id}-${local.date}`,
      title,
    });

    await storeDelivery(supabase, "daily_reading", reminderKey, reminder.user_id);

    sent += 1;
  }

  return sent;
}

async function processGroupPrayerReminders(
  supabase: ReturnType<typeof createClient>,
  now: Date,
  windowMinutes: number,
) {
  const { data, error } = await supabase
    .from("group_prayer_schedules")
    .select("id, group_id, created_by_user_id, scheduled_for, reminder_minutes, timezone")
    .is("cancelled_at", null)
    .order("scheduled_for", { ascending: true });

  if (error) throw error;

  const schedules = (data ?? []) as PrayerScheduleRow[];
  const groupsById = await loadGroupsById(
    supabase,
    Array.from(new Set(schedules.map((row) => row.group_id))),
  );

  let sent = 0;
  for (const schedule of schedules) {
    const group = groupsById.get(schedule.group_id);
    if (!group) continue;

    const scheduledAtMs = new Date(schedule.scheduled_for).getTime();
    if (Number.isNaN(scheduledAtMs)) {
      continue;
    }
    const reminderMinutes = Math.max(0, Number(schedule.reminder_minutes) || 0);
    const preReminderAtMs = scheduledAtMs - (reminderMinutes * 60 * 1000);
    const windowStartMs = now.getTime() - (windowMinutes * 60 * 1000);

    const isWithinWindow = (targetMs: number) =>
      targetMs <= now.getTime() && targetMs > windowStartMs;

    const shouldSendPreReminder = reminderMinutes > 0 && isWithinWindow(preReminderAtMs);
    const shouldSendStartReminder = isWithinWindow(scheduledAtMs);

    if (!shouldSendPreReminder && !shouldSendStartReminder) {
      continue;
    }

    const { data: members, error: membershipError } = await supabase
      .from("group_memberships")
      .select("user_id")
      .eq("group_id", group.id);

    if (membershipError) throw membershipError;

    const recipientUserIds = Array.from(new Set([
      ...(members ?? []).map((member: Record<string, unknown>) => String(member.user_id)),
      ...(schedule.created_by_user_id ? [String(schedule.created_by_user_id)] : []),
    ]));
    if (recipientUserIds.length) {
      const startsLabel = new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: schedule.timezone || "UTC",
      }).format(new Date(schedule.scheduled_for));

      const deliverStage = async (
        stage: "pre" | "start",
        title: string,
        body: string,
      ) => {
        const recipientsToNotify: string[] = [];
        for (const recipientUserId of recipientUserIds) {
          const reminderKey = `${schedule.id}:${stage}`;
          if (await deliveryExists(supabase, "group_prayer", reminderKey, recipientUserId)) {
            continue;
          }
          recipientsToNotify.push(recipientUserId);
        }

        if (!recipientsToNotify.length) {
          return 0;
        }

        const metadata = {
          groupSlug: group.slug,
          reminderMinutes,
          scheduledFor: schedule.scheduled_for,
          source: stage === "start" ? "group_prayer_start" : "group_prayer_reminder",
          timezone: schedule.timezone,
        };

        const rows = recipientsToNotify.map((recipientUserId) => ({
          body,
          group_id: group.id,
          metadata,
          notification_type: "group_prayer_reminder",
          recipient_user_id: recipientUserId,
          title,
        }));
        const { error: insertError } = await supabase.from("notifications").insert(rows);
        if (insertError) throw insertError;

        await sendPushToUsers(supabase, recipientsToNotify, {
          body,
          data: {
            groupId: group.id,
            type: "group_prayer_reminder",
            url: buildHomeUrl("schedule", group.slug),
            ...metadata,
          },
          tag: `group-prayer-${stage}-${schedule.id}`,
          title,
        });

        for (const recipientUserId of recipientsToNotify) {
          await storeDelivery(supabase, "group_prayer", `${schedule.id}:${stage}`, recipientUserId);
        }

        return recipientsToNotify.length;
      };

      if (shouldSendPreReminder) {
        sent += await deliverStage(
          "pre",
          "Upcoming group prayer",
          `Group prayer for ${group.name} begins in ${reminderMinutes} minute${reminderMinutes === 1 ? "" : "s"} at ${startsLabel}.`,
        );
      }

      if (shouldSendStartReminder) {
        sent += await deliverStage(
          "start",
          "Group prayer is starting",
          `Group prayer for ${group.name} is starting now.`,
        );
      }
    }

    if (shouldSendStartReminder) {
      const { error: updateError } = await supabase
        .from("group_prayer_schedules")
        .update({
          reminder_sent_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq("id", schedule.id);

      if (updateError) throw updateError;
    }
  }

  return sent;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  try {
    if (request.method !== "POST") {
      return json(request, 405, { error: "Method not allowed.", ok: false });
    }

    if (!requireReminderSecret(request)) {
      return json(request, 401, { error: "Invalid reminder secret.", ok: false });
    }

    const supabase = await getSupabase();
    const now = new Date();
    const windowMinutes = Math.max(1, Number(Deno.env.get("PRAYERBOX_REMINDER_WINDOW_MINUTES") || 5));

    const dailyReadingSent = await processDailyReadingReminders(supabase, now, windowMinutes);
    const groupPrayerSent = await processGroupPrayerReminders(supabase, now, windowMinutes);

    return json(request, 200, {
      ok: true,
      processedAt: now.toISOString(),
      summary: {
        dailyReadingSent,
        groupPrayerSent,
      },
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
