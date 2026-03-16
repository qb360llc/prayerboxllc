import { createClient } from "jsr:@supabase/supabase-js@2";

type SetDeviceNameRequest = {
  deviceId?: string;
  displayName?: string;
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

    const body = await request.json() as SetDeviceNameRequest;
    const deviceUid = body.deviceId?.trim();
    const displayName = body.displayName?.trim();

    if (!deviceUid || !displayName) {
      return json(request, 400, { error: "deviceId and displayName are required.", ok: false });
    }

    if (displayName.length > 80) {
      return json(request, 400, { error: "Display name must be 80 characters or fewer.", ok: false });
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
      .select("id, device_uid, owner_user_id, display_name, group_id")
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
      return json(request, 403, { error: "Not allowed to rename this device.", ok: false });
    }

    if (device.display_name === displayName) {
      return json(request, 200, {
        device: {
          deviceId: device.device_uid,
          displayName,
        },
        ok: true,
      });
    }

    const { error: updateError } = await supabase
      .from("devices")
      .update({ display_name: displayName })
      .eq("id", device.id);

    if (updateError) {
      throw updateError;
    }

    const { error: eventInsertError } = await supabase
      .from("device_events")
      .insert({
        device_id: device.id,
        event_type: "display_name_changed",
        payload: {
          actorUserId: user.id,
          newDisplayName: displayName,
          oldDisplayName: device.display_name,
          source: "portal",
        },
      });

    if (eventInsertError) {
      throw eventInsertError;
    }

    return json(request, 200, {
      device: {
        deviceId: device.device_uid,
        displayName,
      },
      ok: true,
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
