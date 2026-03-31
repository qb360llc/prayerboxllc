import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPushToUsers } from "../_shared/web-push.ts";

type ActivationEvent = {
  active: boolean;
  deviceId: string;
  groupId: string;
  topic?: string;
  uptimeMs?: number;
};

type DeviceRow = {
  group_id: string;
  id: string;
};

type GroupActivityRow = {
  active_count: number;
  group_id: string;
  lighting_mode: "off" | "solid" | "flash";
  slug: string;
};

function buildHomeUrl(open?: "feed" | "chat" | "reading", groupSlug?: unknown) {
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

const corsHeaders = {
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-client-info, x-prayerbox-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: {
      ...corsHeaders,
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
  if (!recipientUserIds.length) return;

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

  await sendPushToUsers(supabase, recipientUserIds, {
    body,
    data: {
      groupId,
      type: "lights_activated",
      url: buildHomeUrl(undefined, metadata.groupSlug),
      ...metadata,
    },
    tag: `lights-${groupId}-${crypto.randomUUID()}`,
    title,
  });
}

function validateSecret(request: Request) {
  const configuredSecret = Deno.env.get("PRAYERBOX_WEBHOOK_SECRET");
  if (!configuredSecret) {
    return;
  }

  const receivedSecret = request.headers.get("x-prayerbox-webhook-secret");
  if (receivedSecret !== configuredSecret) {
    throw new Error("Invalid webhook secret.");
  }
}

function normalizePayload(input: ActivationEvent) {
  if (!input.deviceId || !input.groupId) {
    throw new Error("deviceId and groupId are required.");
  }

  return {
    active: Boolean(input.active),
    deviceId: input.deviceId.trim(),
    groupId: input.groupId.trim(),
    topic: input.topic?.trim(),
    uptimeMs: typeof input.uptimeMs === "number" ? input.uptimeMs : null,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  try {
    validateSecret(request);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const payload = normalizePayload(await request.json() as ActivationEvent);
    const now = new Date().toISOString();

    const { data: groupRow, error: groupError } = await supabase
      .from("app_groups")
      .select("id, slug")
      .eq("slug", payload.groupId)
      .maybeSingle();

    if (groupError) {
      throw groupError;
    }

    if (!groupRow) {
      throw new Error(`Unknown group slug: ${payload.groupId}`);
    }

    const { data: existingDeviceData, error: deviceLookupError } = await supabase
      .from("devices")
      .select("id, group_id")
      .eq("device_uid", payload.deviceId)
      .maybeSingle();

    if (deviceLookupError) {
      throw deviceLookupError;
    }

    const existingDevice = existingDeviceData as DeviceRow | null;
    let deviceId = existingDevice?.id;
    let deviceOwnerUserId: string | null = null;
    let deviceDisplayName = payload.deviceId;

    if (!existingDevice) {
      const { data: insertedDevice, error: insertDeviceError } = await supabase
        .from("devices")
        .insert({
          device_uid: payload.deviceId,
          display_name: payload.deviceId,
          group_id: groupRow.id,
          is_active: payload.active,
          is_online: true,
          last_seen_at: now,
        })
        .select("id, owner_user_id, display_name")
        .single();

      if (insertDeviceError) {
        throw insertDeviceError;
      }

      deviceId = insertedDevice.id;
      deviceOwnerUserId = insertedDevice.owner_user_id;
      deviceDisplayName = insertedDevice.display_name || payload.deviceId;
    } else {
      const { data: currentDevice, error: currentDeviceError } = await supabase
        .from("devices")
        .select("owner_user_id, display_name")
        .eq("id", existingDevice.id)
        .single();

      if (currentDeviceError) {
        throw currentDeviceError;
      }

      deviceOwnerUserId = currentDevice.owner_user_id;
      deviceDisplayName = currentDevice.display_name || payload.deviceId;

      const { error: updateDeviceError } = await supabase
        .from("devices")
        .update({
          group_id: groupRow.id,
          is_active: payload.active,
          is_online: true,
          last_seen_at: now,
        })
        .eq("id", existingDevice.id);

      if (updateDeviceError) {
        throw updateDeviceError;
      }
    }

    const { error: eventInsertError } = await supabase
      .from("device_events")
      .insert({
        device_id: deviceId,
        event_type: "activation_changed",
        payload: {
          active: payload.active,
          groupId: payload.groupId,
          topic: payload.topic,
          uptimeMs: payload.uptimeMs,
        },
      });

    if (eventInsertError) {
      throw eventInsertError;
    }

    const { data: groupActivityData, error: activityError } = await supabase
      .from("group_activity")
      .select("group_id, slug, active_count, lighting_mode")
      .eq("slug", payload.groupId)
      .single();

    if (activityError) {
      throw activityError;
    }

    const groupActivity = groupActivityData as GroupActivityRow;
    await publishLightingMode(groupActivity.lighting_mode, groupActivity.slug);

    if (payload.active && deviceOwnerUserId) {
      const actorName = await getActorName(supabase, deviceOwnerUserId);
      await notifyGroupMembers(
        supabase,
        groupRow.id,
        deviceOwnerUserId,
        "Lights activated",
        `${actorName} activated ${deviceDisplayName} in ${groupRow.slug}.`,
        {
          deviceId: payload.deviceId,
          groupSlug: groupRow.slug,
          source: "device",
        },
      );
    }

    return json(200, {
      activeCount: groupActivity.active_count,
      deviceId: payload.deviceId,
      groupId: groupActivity.slug,
      lightingMode: groupActivity.lighting_mode,
      ok: true,
    });
  } catch (error) {
    return json(400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
