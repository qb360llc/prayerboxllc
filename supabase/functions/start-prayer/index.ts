import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPushToUsers } from "../_shared/web-push.ts";

type StartPrayerRequest = {
  action?: "start" | "stop";
  groupSlug?: string;
  intention?: string;
};

type GroupActivityRow = {
  active_count: number;
  lighting_mode: "off" | "solid" | "flash";
  slug: string;
};

type GroupRow = {
  id: string;
  name: string;
  slug: string;
};

type DeviceRow = {
  device_uid: string;
  display_name: string;
  id: string;
};

type PrayerParticipant = {
  avatarUrl?: string | null;
  startedAt: string;
  userId: string;
  name: string;
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

  const recipientUserIds = (members ?? []).map((member: Record<string, unknown>) =>
    String(member.user_id)
  );
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

async function getGroupForUser(
  supabase: ReturnType<typeof createClient>,
  groupSlug: string,
  userId: string,
) {
  const { data: group, error: groupError } = await supabase
    .from("app_groups")
    .select("id, slug, name")
    .eq("slug", groupSlug)
    .maybeSingle();

  if (groupError) {
    throw groupError;
  }

  if (!group) {
    throw new Error("Unknown group.");
  }

  const { data: membership, error: membershipError } = await supabase
    .from("group_memberships")
    .select("id")
    .eq("group_id", group.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (membershipError) {
    throw membershipError;
  }

  if (!membership) {
    throw new Error("Join this community before starting prayer.");
  }

  return group as GroupRow;
}

async function getUserDevices(
  supabase: ReturnType<typeof createClient>,
  groupId: string,
  userId: string,
) {
  const { data, error } = await supabase
    .from("devices")
    .select("id, device_uid, display_name")
    .eq("group_id", groupId)
    .eq("owner_user_id", userId);

  if (error) {
    throw error;
  }

  return (data ?? []) as DeviceRow[];
}

async function getPrayerParticipants(
  supabase: ReturnType<typeof createClient>,
  groupId: string,
) {
  const { data: presenceRows, error: presenceError } = await supabase
    .from("prayer_presence")
    .select("user_id, started_at")
    .eq("group_id", groupId)
    .order("started_at", { ascending: true });

  if (presenceError) {
    throw presenceError;
  }

  const rows = (presenceRows ?? []) as Array<{ started_at: string; user_id: string }>;
  const userIds = Array.from(new Set(rows.map((row) => row.user_id)));
  if (!userIds.length) {
    return [] as PrayerParticipant[];
  }

  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, display_name, email, avatar_url")
    .in("id", userIds);

  if (profilesError) {
    throw profilesError;
  }

  const participantsByUserId = new Map(
    (profiles ?? []).map((profile: Record<string, unknown>) => {
      const fullName = [profile.first_name, profile.last_name]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
        .join(" ");

      return [
        String(profile.id),
        {
          avatarUrl: typeof profile.avatar_url === "string" ? profile.avatar_url.trim() : null,
          name: fullName || String(profile.display_name || profile.email || "Community member"),
        },
      ];
    }),
  );

  return rows.map((row) => ({
    avatarUrl: participantsByUserId.get(row.user_id)?.avatarUrl || null,
    startedAt: row.started_at,
    userId: row.user_id,
    name: participantsByUserId.get(row.user_id)?.name || "Community member",
  }));
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
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

    if (request.method === "GET") {
      const url = new URL(request.url);
      const groupSlug = url.searchParams.get("groupSlug")?.trim();
      if (!groupSlug) {
        return json(request, 400, { error: "groupSlug is required.", ok: false });
      }

      const group = await getGroupForUser(supabase, groupSlug, user.id);
      const participants = await getPrayerParticipants(supabase, group.id);
      const ownActiveCount = participants.some((participant) => participant.userId === user.id) ? 1 : 0;

      const { data: groupActivityData, error: activityError } = await supabase
        .from("group_activity")
        .select("slug, active_count, lighting_mode")
        .eq("slug", group.slug)
        .single();

      if (activityError) {
        throw activityError;
      }

      const groupActivity = groupActivityData as GroupActivityRow;
      return json(request, 200, {
        ok: true,
        group: {
          groupId: group.id,
          groupName: group.name,
          groupSlug: group.slug,
        },
        prayerState: {
          activeCount: participants.length,
          lightingMode: groupActivity.lighting_mode,
          othersInPrayerCount: participants.filter((participant) => participant.userId !== user.id).length,
          ownActiveCount,
          participants,
        },
      });
    }

    if (request.method !== "POST") {
      return json(request, 405, { error: "Method not allowed.", ok: false });
    }

    const body = await request.json() as StartPrayerRequest;
    const action = body.action === "stop" ? "stop" : "start";
    const groupSlug = body.groupSlug?.trim();
    const intention = body.intention?.trim() || "";

    if (!groupSlug) {
      return json(request, 400, { error: "groupSlug is required.", ok: false });
    }

    const group = await getGroupForUser(supabase, groupSlug, user.id);
    const devices = await getUserDevices(supabase, group.id, user.id);
    const now = new Date().toISOString();
    const deviceIds = devices.map((device) => device.id);
    const nextActiveState = action === "start";

    if (action === "start") {
      const { error: presenceError } = await supabase
        .from("prayer_presence")
        .upsert(
          {
            group_id: group.id,
            started_at: now,
            user_id: user.id,
          },
          { onConflict: "group_id,user_id" },
        );

      if (presenceError) {
        throw presenceError;
      }

      const { error: eventError } = await supabase
        .from("prayer_presence_events")
        .insert({
          event_type: "entered",
          group_id: group.id,
          user_id: user.id,
        });

      if (eventError) {
        throw eventError;
      }
    } else {
      const { data: existingPresence, error: presenceLookupError } = await supabase
        .from("prayer_presence")
        .select("id")
        .eq("group_id", group.id)
        .eq("user_id", user.id)
        .maybeSingle();

      if (presenceLookupError) {
        throw presenceLookupError;
      }

      const { error: deletePresenceError } = await supabase
        .from("prayer_presence")
        .delete()
        .eq("group_id", group.id)
        .eq("user_id", user.id);

      if (deletePresenceError) {
        throw deletePresenceError;
      }

      if (existingPresence) {
        const { error: eventError } = await supabase
          .from("prayer_presence_events")
          .insert({
            event_type: "left",
            group_id: group.id,
            user_id: user.id,
          });

        if (eventError) {
          throw eventError;
        }
      }
    }

    if (deviceIds.length) {
      const { error: deviceUpdateError } = await supabase
        .from("devices")
        .update({
          is_active: nextActiveState,
          last_seen_at: now,
        })
        .in("id", deviceIds);

      if (deviceUpdateError) {
        throw deviceUpdateError;
      }

      const eventRows = devices.map((device) => ({
        device_id: device.id,
        event_type: "portal_activation_changed",
        payload: {
          active: nextActiveState,
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
    }

    let intentionId: string | null = null;
    if (action === "start" && intention) {
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
    if (deviceIds.length) {
      await publishLightingMode(groupActivity.lighting_mode, groupActivity.slug);
    }

    const actorName = await getActorName(supabase, user.id);
    const preview = intention.replace(/\s+/g, " ").trim().slice(0, 160);
    const notificationBody = action === "start"
      ? (intention
        ? `${actorName} has entered into prayer in ${group.name}: "${preview}${intention.length > preview.length ? "..." : ""}"`
        : `${actorName} has entered into prayer in ${group.name} without adding an intention.`)
      : `${actorName} has left prayer in ${group.name}.`;

    const pushResult = await notifyGroupMembers(
      supabase,
      group.id,
      user.id,
      action === "start" ? "Prayer started" : "Prayer ended",
      notificationBody,
      {
        action,
        groupSlug: group.slug,
        intentionId,
        preview: preview || null,
        source: "home_prayer",
      },
    );

    const participants = await getPrayerParticipants(supabase, group.id);
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
      prayerState: {
        activeCount: participants.length,
        othersInPrayerCount: participants.filter((participant) => participant.userId !== user.id).length,
        ownActiveCount: participants.some((participant) => participant.userId === user.id) ? 1 : 0,
        participants,
      },
      intention: action === "start" ? (intention || null) : null,
      intentionId,
      pushResult,
      action,
      devices: devices.map((device) => ({
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
