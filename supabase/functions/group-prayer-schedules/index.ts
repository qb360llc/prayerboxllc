import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPushToUsers } from "../_shared/web-push.ts";

type ScheduleRequest = {
  clear?: boolean;
  groupSlug?: string;
  reminderMinutes?: number;
  scheduledFor?: string;
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

function normalizeTimezone(value?: string | null) {
  const timezone = value?.trim();
  return timezone || "UTC";
}

function normalizeReminderMinutes(value?: number | null) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1440) {
    throw new Error("reminderMinutes must be between 0 and 1440.");
  }
  return Math.round(number);
}

function normalizeScheduledFor(value?: string | null) {
  const scheduledFor = value?.trim();
  if (!scheduledFor) {
    throw new Error("scheduledFor is required.");
  }

  const parsed = new Date(scheduledFor);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("scheduledFor must be a valid date/time.");
  }

  if (parsed.getTime() <= Date.now()) {
    throw new Error("Choose a future time for group prayer.");
  }

  return parsed.toISOString();
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

async function getActorName(supabase: ReturnType<typeof createClient>, userId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("first_name, last_name, display_name, email")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;

  const fullName = [data?.first_name, data?.last_name]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(" ");

  return fullName || data?.display_name || data?.email || "Someone";
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
  if (!membership) throw new Error("Join this community before scheduling group prayer.");

  return group;
}

async function loadUpcomingSchedule(
  supabase: ReturnType<typeof createClient>,
  groupId: string,
) {
  const { data, error } = await supabase
    .from("group_prayer_schedules")
    .select("id, created_by_user_id, scheduled_for, reminder_minutes, timezone, created_at, updated_at")
    .eq("group_id", groupId)
    .is("cancelled_at", null)
    .gte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function notifyGroupMembers(
  supabase: ReturnType<typeof createClient>,
  groupId: string,
  actorUserId: string,
  title: string,
  body: string,
  metadata: Record<string, unknown>,
) {
  const { data: members, error } = await supabase
    .from("group_memberships")
    .select("user_id")
    .eq("group_id", groupId)
    .neq("user_id", actorUserId);

  if (error) throw error;

  const recipientUserIds = (members ?? []).map((member: Record<string, unknown>) => String(member.user_id));
  if (!recipientUserIds.length) {
    return {
      attempted: 0,
      failed: 0,
      failures: [],
      sent: 0,
    };
  }

  const rows = recipientUserIds.map((recipientUserId) => ({
    actor_user_id: actorUserId,
    body,
    group_id: groupId,
    metadata,
    notification_type: "group_prayer_scheduled",
    recipient_user_id: recipientUserId,
    title,
  }));

  const { error: insertError } = await supabase.from("notifications").insert(rows);
  if (insertError) throw insertError;

  return await sendPushToUsers(supabase, recipientUserIds, {
    body,
    data: {
      groupId,
      type: "group_prayer_scheduled",
      url: buildHomeUrl("schedule", metadata.groupSlug),
      ...metadata,
    },
    tag: `group-prayer-scheduled-${groupId}-${crypto.randomUUID()}`,
    title,
  });
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
      const schedule = await loadUpcomingSchedule(supabase, group.id);

      let createdBy = "";
      if (schedule?.created_by_user_id) {
        createdBy = await getActorName(supabase, String(schedule.created_by_user_id));
      }

      return json(request, 200, {
        ok: true,
        schedule: schedule
          ? {
            createdAt: schedule.created_at,
            createdBy,
            createdByUserId: schedule.created_by_user_id,
            id: schedule.id,
            reminderMinutes: schedule.reminder_minutes,
            scheduledFor: schedule.scheduled_for,
            timezone: schedule.timezone,
            updatedAt: schedule.updated_at,
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
        .from("group_prayer_schedules")
        .update({
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("group_id", group.id)
        .is("cancelled_at", null)
        .gte("scheduled_for", new Date().toISOString());

      if (error) throw error;

      return json(request, 200, { ok: true, schedule: null, removed: true });
    }

    if (request.method !== "POST") {
      return json(request, 405, { error: "Method not allowed.", ok: false });
    }

    const body = await request.json() as ScheduleRequest;
    const groupSlug = body.groupSlug?.trim();
    if (!groupSlug) {
      return json(request, 400, { error: "groupSlug is required.", ok: false });
    }

    const group = await getGroupForUser(supabase, user.id, groupSlug);

    if (body.clear) {
      const { error } = await supabase
        .from("group_prayer_schedules")
        .update({
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("group_id", group.id)
        .is("cancelled_at", null)
        .gte("scheduled_for", new Date().toISOString());

      if (error) throw error;
      return json(request, 200, { ok: true, schedule: null, removed: true });
    }

    const scheduledFor = normalizeScheduledFor(body.scheduledFor);
    const reminderMinutes = normalizeReminderMinutes(body.reminderMinutes ?? 15);
    const timezone = normalizeTimezone(body.timezone);
    const now = new Date().toISOString();

    const { error: cancelExistingError } = await supabase
      .from("group_prayer_schedules")
      .update({
        cancelled_at: now,
        updated_at: now,
      })
      .eq("group_id", group.id)
      .is("cancelled_at", null)
      .gte("scheduled_for", now);

    if (cancelExistingError) throw cancelExistingError;

    const { data: inserted, error: insertError } = await supabase
      .from("group_prayer_schedules")
      .insert({
        created_by_user_id: user.id,
        group_id: group.id,
        reminder_minutes: reminderMinutes,
        scheduled_for: scheduledFor,
        timezone,
      })
      .select("id, created_by_user_id, scheduled_for, reminder_minutes, timezone, created_at, updated_at")
      .single();

    if (insertError) throw insertError;

    const actorName = await getActorName(supabase, user.id);
    const scheduledLabel = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(scheduledFor));
    const bodyText = `${actorName} suggested group prayer for ${scheduledLabel} in ${group.name}. Reminder ${reminderMinutes} minute${reminderMinutes === 1 ? "" : "s"} before.`;

    const pushResult = await notifyGroupMembers(
      supabase,
      group.id,
      user.id,
      "Group prayer scheduled",
      bodyText,
      {
        groupSlug: group.slug,
        reminderMinutes,
        scheduledFor,
        source: "group_prayer_schedule",
        timezone,
      },
    );

    return json(request, 200, {
      ok: true,
      pushResult,
      schedule: {
        createdAt: inserted.created_at,
        createdBy: actorName,
        createdByUserId: inserted.created_by_user_id,
        id: inserted.id,
        reminderMinutes: inserted.reminder_minutes,
        scheduledFor: inserted.scheduled_for,
        timezone: inserted.timezone,
        updatedAt: inserted.updated_at,
      },
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
