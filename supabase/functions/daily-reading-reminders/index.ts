import { createClient } from "jsr:@supabase/supabase-js@2";

type ReminderRequest = {
  clear?: boolean;
  groupSlug?: string;
  reminderTime?: string;
  timezone?: string;
};

function corsHeaders(request: Request) {
  const allowedOrigin = Deno.env.get("PRAYERBOX_PORTAL_ORIGIN");
  const requestOrigin = request.headers.get("Origin");
  const origin = allowedOrigin
    ? (requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin)
    : "*";

  return {
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    "Access-Control-Allow-Methods": "DELETE, GET, POST, OPTIONS",
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

function normalizeTimezone(value?: string | null) {
  const timezone = value?.trim();
  if (!timezone) {
    return "UTC";
  }
  return timezone;
}

function normalizeReminderTime(value?: string | null) {
  const reminderTime = value?.trim();
  if (!reminderTime) {
    throw new Error("reminderTime is required.");
  }

  const match = reminderTime.match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!match) {
    throw new Error("reminderTime must be HH:MM.");
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("reminderTime must be a valid time.");
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function zonedDateParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
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
    day: Number(values.day || 1),
    month: Number(values.month || 1),
    year: Number(values.year || 1970),
  };
}

function getTimeZoneOffsetMs(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: timezone,
    year: "numeric",
  });

  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const asUtc = Date.UTC(
    Number(values.year || 1970),
    Number(values.month || 1) - 1,
    Number(values.day || 1),
    Number(values.hour || 0),
    Number(values.minute || 0),
    Number(values.second || 0),
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstPass = guess - getTimeZoneOffsetMs(new Date(guess), timezone);
  const secondPass = guess - getTimeZoneOffsetMs(new Date(firstPass), timezone);
  return new Date(secondPass);
}

function addDays(year: number, month: number, day: number, amount: number) {
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    year: date.getUTCFullYear(),
  };
}

function nextDailyTriggerAt(reminderTime: string, timezone: string, now = new Date()) {
  const match = String(reminderTime).match(/^(\d{2}):(\d{2})/);
  if (!match) {
    throw new Error(`Invalid reminder time "${reminderTime}".`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const today = zonedDateParts(now, timezone);
  const todayTrigger = zonedDateTimeToUtc(today.year, today.month, today.day, hour, minute, timezone);
  if (todayTrigger.getTime() > now.getTime()) {
    return todayTrigger;
  }

  const tomorrow = addDays(today.year, today.month, today.day, 1);
  return zonedDateTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, timezone);
}

async function getSupabase() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

async function getAuthedUser(request: Request, supabase: ReturnType<typeof createClient>) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token.");
  }

  const jwt = authHeader.replace("Bearer ", "");
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error) throw error;
  if (!data.user) throw new Error("Invalid user token.");
  return data.user;
}

async function getProfile(supabase: ReturnType<typeof createClient>, userId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getGroupForUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  groupSlug: string,
) {
  const { data: group, error: groupError } = await supabase
    .from("app_groups")
    .select("id, slug, name")
    .eq("slug", groupSlug)
    .maybeSingle();

  if (groupError) throw groupError;
  if (!group) throw new Error("Unknown group.");

  const profile = await getProfile(supabase, userId);
  if (profile?.is_admin) {
    return group;
  }

  const { data: membership, error: membershipError } = await supabase
    .from("group_memberships")
    .select("id")
    .eq("group_id", group.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (membershipError) throw membershipError;
  if (!membership) throw new Error("Join this community before setting reminders.");

  return group;
}

async function loadReminder(
  supabase: ReturnType<typeof createClient>,
  groupId: string,
  userId: string,
) {
  const { data, error } = await supabase
    .from("daily_reading_reminders")
    .select("id, reminder_time, timezone, next_trigger_at, updated_at")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  try {
    const supabase = await getSupabase();
    const user = await getAuthedUser(request, supabase);

    if (request.method === "GET") {
      const url = new URL(request.url);
      const groupSlug = url.searchParams.get("groupSlug")?.trim();
      if (!groupSlug) {
        return json(request, 400, { error: "groupSlug is required.", ok: false });
      }

      const group = await getGroupForUser(supabase, user.id, groupSlug);
      const reminder = await loadReminder(supabase, group.id, user.id);

      return json(request, 200, {
        ok: true,
        reminder: reminder
          ? {
            id: reminder.id,
            nextTriggerAt: reminder.next_trigger_at,
            reminderTime: String(reminder.reminder_time).slice(0, 5),
            timezone: reminder.timezone,
            updatedAt: reminder.updated_at,
          }
          : null,
      });
    }

    if (request.method === "DELETE") {
      const url = new URL(request.url);
      const groupSlug = url.searchParams.get("groupSlug")?.trim();
      if (!groupSlug) {
        return json(request, 400, { error: "groupSlug is required.", ok: false });
      }

      const group = await getGroupForUser(supabase, user.id, groupSlug);
      const { error } = await supabase
        .from("daily_reading_reminders")
        .delete()
        .eq("group_id", group.id)
        .eq("user_id", user.id);

      if (error) throw error;

      return json(request, 200, { ok: true, reminder: null, removed: true });
    }

    if (request.method !== "POST") {
      return json(request, 405, { error: "Method not allowed.", ok: false });
    }

    const body = await request.json() as ReminderRequest;
    const groupSlug = body.groupSlug?.trim();
    if (!groupSlug) {
      return json(request, 400, { error: "groupSlug is required.", ok: false });
    }

    const group = await getGroupForUser(supabase, user.id, groupSlug);
    if (body.clear) {
      const { error } = await supabase
        .from("daily_reading_reminders")
        .delete()
        .eq("group_id", group.id)
        .eq("user_id", user.id);

      if (error) throw error;
      return json(request, 200, { ok: true, reminder: null, removed: true });
    }

    const reminderTime = normalizeReminderTime(body.reminderTime);
    const timezone = normalizeTimezone(body.timezone);
    const nextTriggerAt = nextDailyTriggerAt(reminderTime, timezone).toISOString();

    const { data, error } = await supabase
      .from("daily_reading_reminders")
      .upsert({
        group_id: group.id,
        next_trigger_at: nextTriggerAt,
        reminder_time: reminderTime,
        timezone,
        updated_at: new Date().toISOString(),
        user_id: user.id,
      }, { onConflict: "user_id,group_id" })
      .select("id, reminder_time, timezone, next_trigger_at, updated_at")
      .single();

    if (error) throw error;

    return json(request, 200, {
      ok: true,
      reminder: {
        id: data.id,
        nextTriggerAt: data.next_trigger_at,
        reminderTime: String(data.reminder_time).slice(0, 5),
        timezone: data.timezone,
        updatedAt: data.updated_at,
      },
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
