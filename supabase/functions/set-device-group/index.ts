import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

type SetDeviceGroupRequest = {
  deviceId?: string;
  groupSlug?: string;
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

async function publishLightingMode(mode: GroupActivityRow["lighting_mode"], groupSlug: string) {
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

async function loadGroupActivity(supabase: SupabaseClient, groupSlug: string) {
  const { data, error } = await supabase
    .from("group_activity")
    .select("slug, active_count, lighting_mode")
    .eq("slug", groupSlug)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as GroupActivityRow | null;
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

    const body = await request.json() as SetDeviceGroupRequest;
    const deviceUid = body.deviceId?.trim();
    const groupSlug = body.groupSlug?.trim();

    if (!deviceUid || !groupSlug) {
      return json(request, 400, { error: "deviceId and groupSlug are required.", ok: false });
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
      .select(`
        id,
        device_uid,
        display_name,
        owner_user_id,
        group_id,
        app_groups!devices_group_id_fkey (
          slug,
          name
        )
      `)
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
      return json(request, 403, { error: "Not allowed to move this device.", ok: false });
    }

    const { data: targetGroup, error: targetGroupError } = await supabase
      .from("app_groups")
      .select("id, slug, name")
      .eq("slug", groupSlug)
      .maybeSingle();

    if (targetGroupError) {
      throw targetGroupError;
    }

    if (!targetGroup) {
      return json(request, 404, { error: "Unknown group.", ok: false });
    }

    if (!isAdmin) {
      const { data: membership, error: membershipError } = await supabase
        .from("group_memberships")
        .select("id")
        .eq("group_id", targetGroup.id)
        .eq("user_id", user.id)
        .maybeSingle();

      if (membershipError) {
        throw membershipError;
      }

      if (!membership) {
        return json(request, 403, { error: "Join the target group before moving a device into it.", ok: false });
      }
    }

    const currentGroup = device.app_groups as Record<string, unknown> | null;
    if (currentGroup?.slug === targetGroup.slug) {
      return json(request, 200, {
        device: {
          deviceId: device.device_uid,
          displayName: device.display_name,
          groupId: targetGroup.slug,
          groupName: targetGroup.name,
        },
        ok: true,
      });
    }

    const { error: updateError } = await supabase
      .from("devices")
      .update({ group_id: targetGroup.id })
      .eq("id", device.id);

    if (updateError) {
      throw updateError;
    }

    const { error: eventInsertError } = await supabase
      .from("device_events")
      .insert({
        device_id: device.id,
        event_type: "group_changed",
        payload: {
          actorUserId: user.id,
          newGroupSlug: targetGroup.slug,
          oldGroupSlug: currentGroup?.slug ?? null,
          source: "portal",
        },
      });

    if (eventInsertError) {
      throw eventInsertError;
    }

    const slugsToPublish = new Set<string>();
    if (typeof currentGroup?.slug === "string") {
      slugsToPublish.add(currentGroup.slug);
    }
    slugsToPublish.add(targetGroup.slug);

    const groupStates = [];
    for (const slug of slugsToPublish) {
      const activity = await loadGroupActivity(supabase, slug);
      if (activity) {
        await publishLightingMode(activity.lighting_mode, activity.slug);
        groupStates.push({
          activeCount: activity.active_count,
          lightingMode: activity.lighting_mode,
          slug: activity.slug,
        });
      }
    }

    return json(request, 200, {
      device: {
        deviceId: device.device_uid,
        displayName: device.display_name,
        groupId: targetGroup.slug,
        groupName: targetGroup.name,
      },
      groupStates,
      ok: true,
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
