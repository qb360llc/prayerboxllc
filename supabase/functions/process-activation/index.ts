import { createClient } from "jsr:@supabase/supabase-js@2";

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
        .select("id")
        .single();

      if (insertDeviceError) {
        throw insertDeviceError;
      }

      deviceId = insertedDevice.id;
    } else {
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
