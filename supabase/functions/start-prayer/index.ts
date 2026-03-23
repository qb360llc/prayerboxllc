import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPushToUsers } from "../_shared/web-push.ts";

type StartPrayerRequest = {
  groupSlug?: string;
  intention?: string;
};

type GroupActivityRow = {
  active_count: number;
  lighting_mode: "off" | "solid" | "flash";
  slug: string;
};

function corsHeaders(request: Request) {
  const allowedOrigin = Deno.env.get("PRAYERBOX_PORTAL_ORIGIN");
  const requestOrigin = request.headers.get("Origin");
  const origin = allowedOrigin
    ? (requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin)
    : "*";

  return {
    "Access-Control-Allow-Headers":
      "authorization, content-type, x-client-info, apikey",
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

async function publishLightingMode(
  mode: GroupActivityRow["lighting_mode"],
  groupSlug: string,
) {
  const apiBaseUrl = Deno.env.get("EMQX_API_BASE_URL");
  const apiKey = Deno.env.get("EMQX_API_KEY");
  const apiSecret = Deno.env.get("EMQX_API_SECRET");

  if (!apiBaseUrl || !apiKey || !apiSecret) {
    throw new Error("Missing EMQX API environment variables.");
  }

  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/publish`, {
    body: JSON.stringify({
      payload: mode,
      qos: 0,
      retain: false,
      topic: `groups/${groupSlug}/lighting_mode`,
    }),
    headers: {
      Authorization: `Basic ${btoa(`${apiKey}:${apiSecret}`)}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`EMQX publish failed with status ${response.status}.`);
  }
}

async function getActorName(
  supabase: ReturnType<typeof createClient>,
  userId: string,
) {
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
    notification_type: "lights_activated",
    recipient_user_id: recipientUserId,
    title,
  }));

  const { error: insertError } = await supabase.from("notifications").insert(rows);
  if (insertError) throw insertError;

  return await sendPushToUsers(supabase, recipientUserIds, {
    body,
    data: {
      groupId,
      type: "lights_activated",
      url: "/home.html",
      ...metadata,
    },
    tag: `prayer-${groupId}-${crypto.randomUUID()}`,
    title,
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  if (request.method !== "POST") {
    return json(request, 405, { error: "Method not allowed.", ok: false });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json(request, 401, { error: "Missing bearer token.", ok: false });
    }

    const jwt = authHeader.replace("Bearer ", "");
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt);

    if (userError) {
      throw userError;
    }

    const user = userData.user;
    if (!user) {
      return json(request, 401, { error: "Invalid user token.", ok: false });
    }

    const body = await request.json() as StartPrayerRequest;
    const groupSlug = body.groupSlug?.trim();
    const intention = body.intention?.trim() || "";

    if (!groupSlug) {
      return json(request, 400, { error: "groupSlug is required.", ok: false });
    }

    const { data: group, error: groupError } = await supabase
      .from("app_groups")
      .select("id, slug, name")
      .eq("slug", groupSlug)
      .maybeSingle();

    if (groupError) {
      throw groupError;
    }

    if (!group) {
      return json(request, 404, { error: "Unknown group.", ok: false });
    }

    const { data: membership, error: membershipError } = await supabase
      .from("group_memberships")
      .select("id")
      .eq("group_id", group.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (membershipError) {
      throw membershipError;
    }

    if (!membership) {
      return json(request, 403, { error: "Join this community before starting prayer.", ok: false });
    }

    const { data: devices, error: devicesError } = await supabase
      .from("devices")
      .select("id, device_uid, display_name")
      .eq("group_id", group.id)
      .eq("owner_user_id", user.id);

    if (devicesError) {
      throw devicesError;
    }

    if (!devices?.length) {
      return json(request, 400, { error: "Claim a light box in this community before starting prayer.", ok: false });
    }

    const now = new Date().toISOString();
    const deviceIds = devices.map((device: Record<string, unknown>) => String(device.id));

    const { error: deviceUpdateError } = await supabase
      .from("devices")
      .update({
        is_active: true,
        last_seen_at: now,
      })
      .in("id", deviceIds);

    if (deviceUpdateError) {
      throw deviceUpdateError;
    }

    const eventRows = devices.map((device: Record<string, unknown>) => ({
      device_id: device.id,
      event_type: "portal_activation_changed",
      payload: {
        active: true,
        actorUserId: user.id,
        source: "home_prayer",
      },
    }));

    const { error: eventInsertError } = await supabase
      .from("device_events")
      .insert(eventRows);

    if (eventInsertError) {
      throw eventInsertError;
    }

    let intentionId: string | null = null;
    if (intention) {
      const { data: insertedIntention, error: insertIntentionError } = await supabase
        .from("community_intentions")
        .insert({
          body: intention,
          created_by_user_id: user.id,
          group_id: group.id,
        })
        .select("id")
        .single();

      if (insertIntentionError) {
        throw insertIntentionError;
      }

      intentionId = String(insertedIntention.id);
    }

    const { data: groupActivityData, error: activityError } = await supabase
      .from("group_activity")
      .select("slug, active_count, lighting_mode")
      .eq("slug", group.slug)
      .single();

    if (activityError) {
      throw activityError;
    }

    const groupActivity = groupActivityData as GroupActivityRow;
    await publishLightingMode(groupActivity.lighting_mode, groupActivity.slug);

    const actorName = await getActorName(supabase, user.id);
    const preview = intention.replace(/\s+/g, " ").trim().slice(0, 160);
    const notificationBody = intention
      ? `${actorName} has entered into prayer in ${group.name}: "${preview}${intention.length > preview.length ? "..." : ""}"`
      : `${actorName} has entered into prayer in ${group.name} without adding an intention.`;

    const pushResult = await notifyGroupMembers(
      supabase,
      group.id,
      user.id,
      "Prayer started",
      notificationBody,
      {
        groupSlug: group.slug,
        intentionId,
        preview: preview || null,
        source: "home_prayer",
      },
    );

    return json(request, 200, {
      ok: true,
      group: {
        groupId: group.id,
        groupName: group.name,
        groupSlug: group.slug,
      },
      groupState: {
        activeCount: groupActivity.active_count,
        lightingMode: groupActivity.lighting_mode,
      },
      intention: intention || null,
      intentionId,
      pushResult,
      devices: devices.map((device: Record<string, unknown>) => ({
        deviceId: device.device_uid,
        displayName: device.display_name,
      })),
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
