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

type ReminderProcessSummary = {
  dueCount: number;
  sentCount: number;
};

function logWarning(message: string, error: unknown) {
  console.warn(message, error instanceof Error ? error.message : error);
}

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

async function createRunLog(
  supabase: ReturnType<typeof createClient>,
  payload: {
    startedAt: string;
    triggerSource: string;
    windowMinutes: number;
  },
) {
  try {
    const { data, error } = await supabase
      .from("reminder_job_runs")
      .insert({
        started_at: payload.startedAt,
        trigger_source: payload.triggerSource,
        window_minutes: payload.windowMinutes,
      })
      .select("id")
      .single();

    if (error) throw error;
    return String((data as Record<string, unknown>).id);
  } catch (error) {
    logWarning("Unable to create reminder job log.", error);
    return null;
  }
}

async function updateRunLog(
  supabase: ReturnType<typeof createClient>,
  runId: string | null,
  payload: Record<string, unknown>,
) {
  if (!runId) return;
  try {
    const { error } = await supabase
      .from("reminder_job_runs")
      .update(payload)
      .eq("id", runId);

    if (error) throw error;
  } catch (error) {
    logWarning("Unable to update reminder job log.", error);
  }
}

async function insertDeliveryLog(
  supabase: ReturnType<typeof createClient>,
  payload: {
    body: string;
    groupId: string;
    latenessSeconds: number;
    metadata: Record<string, unknown>;
    processedAt: string;
    recipientUserId: string;
    reminderKey: string;
    reminderKind: "daily_reading" | "group_prayer";
    reminderStage: "scheduled" | "pre" | "start";
    runId: string | null;
    scheduledFor?: string | null;
    scheduledLocalDate?: string | null;
    scheduledLocalTime?: string | null;
    timezone?: string | null;
    title: string;
    triggerSource: string;
  },
) {
  try {
    const { error } = await supabase
      .from("reminder_delivery_logs")
      .insert({
        body: payload.body,
        group_id: payload.groupId,
        lateness_seconds: Math.max(0, Math.round(payload.latenessSeconds || 0)),
        metadata: payload.metadata,
        processed_at: payload.processedAt,
        recipient_user_id: payload.recipientUserId,
        reminder_key: payload.reminderKey,
        reminder_kind: payload.reminderKind,
        reminder_stage: payload.reminderStage,
        run_id: payload.runId,
        scheduled_for: payload.scheduledFor || null,
        scheduled_local_date: payload.scheduledLocalDate || null,
        scheduled_local_time: payload.scheduledLocalTime || null,
        timezone: payload.timezone || null,
        title: payload.title,
        trigger_source: payload.triggerSource,
      });

    if (error) throw error;
  } catch (error) {
    logWarning("Unable to insert reminder delivery log.", error);
  }
}

async function processDailyReadingReminders(
  supabase: ReturnType<typeof createClient>,
  now: Date,
  windowMinutes: number,
  runId: string | null,
  triggerSource: string,
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

  let dueCount = 0;
  let sentCount = 0;
  for (const reminder of reminders) {
    const group = groupsById.get(reminder.group_id);
    if (!group) continue;

    const local = zonedParts(now, reminder.timezone || "UTC");
    const reminderTime = parseStoredTime(reminder.reminder_time);
    const currentMinutes = minutesSinceMidnight(local.hour, local.minute);
    const reminderMinutes = minutesSinceMidnight(reminderTime.hour, reminderTime.minute);
    const due = currentMinutes >= reminderMinutes && currentMinutes < (reminderMinutes + windowMinutes);
    if (!due) continue;
    dueCount += 1;

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
    await insertDeliveryLog(supabase, {
      body,
      groupId: group.id,
      latenessSeconds: (currentMinutes - reminderMinutes) * 60,
      metadata,
      processedAt: now.toISOString(),
      recipientUserId: reminder.user_id,
      reminderKey,
      reminderKind: "daily_reading",
      reminderStage: "scheduled",
      runId,
      scheduledLocalDate: local.date,
      scheduledLocalTime: String(reminder.reminder_time).slice(0, 5),
      timezone: reminder.timezone || "UTC",
      title,
      triggerSource,
    });

    sentCount += 1;
  }

  return { dueCount, sentCount } satisfies ReminderProcessSummary;
}

async function processGroupPrayerReminders(
  supabase: ReturnType<typeof createClient>,
  now: Date,
  windowMinutes: number,
  runId: string | null,
  triggerSource: string,
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

  let dueCount = 0;
  let sentCount = 0;
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
        targetMs: number,
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
          const reminderKey = `${schedule.id}:${stage}`;
          await storeDelivery(supabase, "group_prayer", reminderKey, recipientUserId);
          await insertDeliveryLog(supabase, {
            body,
            groupId: group.id,
            latenessSeconds: (now.getTime() - targetMs) / 1000,
            metadata,
            processedAt: now.toISOString(),
            recipientUserId,
            reminderKey,
            reminderKind: "group_prayer",
            reminderStage: stage,
            runId,
            scheduledFor: new Date(targetMs).toISOString(),
            timezone: schedule.timezone || "UTC",
            title,
            triggerSource,
          });
        }

        return recipientsToNotify.length;
      };

      if (shouldSendPreReminder) {
        dueCount += 1;
        sentCount += await deliverStage(
          "pre",
          "Upcoming group prayer",
          `Group prayer for ${group.name} begins in ${reminderMinutes} minute${reminderMinutes === 1 ? "" : "s"} at ${startsLabel}.`,
          preReminderAtMs,
        );
      }

      if (shouldSendStartReminder) {
        dueCount += 1;
        sentCount += await deliverStage(
          "start",
          "Group prayer is starting",
          `Group prayer for ${group.name} is starting now.`,
          scheduledAtMs,
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

  return { dueCount, sentCount } satisfies ReminderProcessSummary;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  let supabase: ReturnType<typeof createClient> | null = null;
  let runId: string | null = null;
  try {
    if (request.method !== "POST") {
      return json(request, 405, { error: "Method not allowed.", ok: false });
    }

    if (!requireReminderSecret(request)) {
      return json(request, 401, { error: "Invalid reminder secret.", ok: false });
    }

    const requestBody = await request.json().catch(() => ({}));
    const triggerSource = typeof (requestBody as Record<string, unknown>)?.source === "string"
      ? String((requestBody as Record<string, unknown>).source).trim() || "manual"
      : "manual";
    supabase = await getSupabase();
    const now = new Date();
    const defaultWindowMinutes = triggerSource === "supabase_cron" ? 2 : 5;
    const windowMinutes = Math.max(1, Number(Deno.env.get("PRAYERBOX_REMINDER_WINDOW_MINUTES") || defaultWindowMinutes));
    runId = await createRunLog(supabase, {
      startedAt: now.toISOString(),
      triggerSource,
      windowMinutes,
    });

    const dailyReading = await processDailyReadingReminders(supabase, now, windowMinutes, runId, triggerSource);
    const groupPrayer = await processGroupPrayerReminders(supabase, now, windowMinutes, runId, triggerSource);

    await updateRunLog(supabase, runId, {
      daily_due_count: dailyReading.dueCount,
      daily_sent_count: dailyReading.sentCount,
      finished_at: new Date().toISOString(),
      group_due_count: groupPrayer.dueCount,
      group_sent_count: groupPrayer.sentCount,
    });

    return json(request, 200, {
      ok: true,
      processedAt: now.toISOString(),
      runId,
      summary: {
        dailyReadingDue: dailyReading.dueCount,
        dailyReadingSent: dailyReading.sentCount,
        groupPrayerDue: groupPrayer.dueCount,
        groupPrayerSent: groupPrayer.sentCount,
      },
    });
  } catch (error) {
    if (supabase && runId) {
      await updateRunLog(supabase, runId, {
        error_text: error instanceof Error ? error.message : "Unknown error",
        finished_at: new Date().toISOString(),
      });
    }
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
