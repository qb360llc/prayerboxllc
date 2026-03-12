import { createClient } from "jsr:@supabase/supabase-js@2";

type SetDeviceActiveRequest = {
  active?: boolean;
  deviceId?: string;
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

    const body = await request.json() as SetDeviceActiveRequest;
    const deviceUid = body.deviceId?.trim();
    if (!deviceUid) {
      return json(request, 400, { error: "deviceId is required.", ok: false });
    }

    if (typeof body.active !== "boolean") {
      return json(request, 400, { error: "active must be a boolean.", ok: false });
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) {
      throw profileError;
    }

    const { data: device, error: deviceError } = await supabase
      .from("devices")
      .select("id, device_uid, display_name, owner_user_id, group_id")
      .eq("device_uid", deviceUid)
      .maybeSingle();

    if (deviceError) {
      throw deviceError;
    }

    if (!device) {
      return json(request, 404, { error: "Unknown device.", ok: false });
    }

    const isAdmin = Boolean(profile?.is_admin);
    const isOwner = device.owner_user_id === user.id;
    if (!isAdmin && !isOwner) {
      return json(request, 403, { error: "Not allowed to control this device.", ok: false });
    }

    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("devices")
      .update({
        is_active: body.active,
        last_seen_at: now,
      })
      .eq("id", device.id);

    if (updateError) {
      throw updateError;
    }

    const { error: eventInsertError } = await supabase
      .from("device_events")
      .insert({
        device_id: device.id,
        event_type: "portal_activation_changed",
        payload: {
          active: body.active,
          actorUserId: user.id,
          source: "portal",
        },
      });

    if (eventInsertError) {
      throw eventInsertError;
    }

    const { data: group, error: groupError } = await supabase
      .from("app_groups")
      .select("slug, name")
      .eq("id", device.group_id)
      .single();

    if (groupError) {
      throw groupError;
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

    return json(request, 200, {
      ok: true,
      device: {
        active: body.active,
        deviceId: device.device_uid,
        displayName: device.display_name,
        groupId: group.slug,
        groupName: group.name,
      },
      groupState: {
        activeCount: groupActivity.active_count,
        lightingMode: groupActivity.lighting_mode,
      },
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
