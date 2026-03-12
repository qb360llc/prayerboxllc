import { createClient } from "jsr:@supabase/supabase-js@2";

function corsHeaders(request: Request) {
  const allowedOrigin = Deno.env.get("PRAYERBOX_PORTAL_ORIGIN");
  const requestOrigin = request.headers.get("Origin");
  const origin = allowedOrigin
    ? (requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin)
    : "*";

  return {
    "Access-Control-Allow-Headers":
      "authorization, content-type, x-client-info, apikey",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

  if (request.method !== "GET") {
    return json(request, 405, { error: "Method not allowed." });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json(request, 401, { error: "Missing bearer token." });
    }

    const jwt = authHeader.replace("Bearer ", "");
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt);

    if (userError) {
      throw userError;
    }

    const user = userData.user;
    if (!user) {
      return json(request, 401, { error: "Invalid user token." });
    }

    const { data, error } = await supabase
      .from("devices")
      .select(`
        device_uid,
        display_name,
        is_active,
        is_online,
        last_seen_at,
        app_groups (
          slug,
          name
        ),
        device_firmware_status (
          current_version,
          last_reported_at,
          last_update_status
        )
      `)
      .eq("owner_user_id", user.id)
      .order("created_at", { ascending: true });

    if (error) {
      throw error;
    }

    const devices = (data ?? []).map((row: Record<string, unknown>) => {
      const group = row.app_groups as Record<string, unknown> | null;
      const firmware = row.device_firmware_status as Record<string, unknown> | null;

      return {
        currentVersion: firmware?.current_version ?? null,
        deviceId: row.device_uid,
        displayName: row.display_name,
        groupId: group?.slug ?? null,
        groupName: group?.name ?? null,
        isActive: row.is_active,
        isOnline: row.is_online,
        lastFirmwareReportAt: firmware?.last_reported_at ?? null,
        lastSeenAt: row.last_seen_at,
        lastUpdateStatus: firmware?.last_update_status ?? null,
      };
    });

    return json(request, 200, {
      devices,
      ok: true,
      owner: {
        email: user.email,
        id: user.id,
      },
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
