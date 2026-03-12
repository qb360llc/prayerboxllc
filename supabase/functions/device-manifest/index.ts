import { createClient } from "jsr:@supabase/supabase-js@2";

type ManifestRequest = {
  channel?: string;
  currentVersion?: string;
  deviceId: string;
};

type DeviceRow = {
  display_name: string;
  group_id: string;
  id: string;
  owner_user_id: string | null;
};

const encoder = new TextEncoder();

function corsHeaders(request: Request) {
  const allowedOrigin = Deno.env.get("PRAYERBOX_PORTAL_ORIGIN");
  const requestOrigin = request.headers.get("Origin");
  const origin = allowedOrigin
    ? (requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin)
    : "*";

  return {
    "Access-Control-Allow-Headers":
      "authorization, content-type, x-client-info, x-prayerbox-device-key",
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

async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function validateDeviceKey(
  request: Request,
  supabase: ReturnType<typeof createClient>,
  device: DeviceRow,
) {
  const receivedKey = request.headers.get("x-prayerbox-device-key");
  if (!receivedKey) {
    throw new Error("Missing device API key.");
  }

  const { data: storedKey, error: keyError } = await supabase
    .from("device_api_keys")
    .select("key_hash")
    .eq("device_id", device.id)
    .maybeSingle();

  if (keyError && keyError.code !== "42P01") {
    throw keyError;
  }

  if (storedKey?.key_hash) {
    const receivedHash = await sha256Hex(receivedKey);
    if (receivedHash !== storedKey.key_hash) {
      throw new Error("Invalid device API key.");
    }

    await supabase
      .from("device_api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("device_id", device.id);

    return;
  }

  const configuredKey = Deno.env.get("PRAYERBOX_DEVICE_API_KEY");
  if (!configuredKey || receivedKey !== configuredKey) {
    throw new Error("Invalid device API key.");
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  if (request.method !== "POST") {
    return json(request, 405, { error: "Method not allowed." });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const body = await request.json() as ManifestRequest;
    const deviceId = body.deviceId?.trim();
    const channel = body.channel?.trim() || "stable";

    if (!deviceId) {
      return json(request, 400, { error: "deviceId is required." });
    }

    const { data: device, error: deviceError } = await supabase
      .from("devices")
      .select("id, device_uid, display_name, group_id, owner_user_id")
      .eq("device_uid", deviceId)
      .maybeSingle();

    if (deviceError) {
      throw deviceError;
    }

    if (!device) {
      return json(request, 404, { error: "Unknown device." });
    }

    await validateDeviceKey(request, supabase, device as DeviceRow);

    const { data: group, error: groupError } = await supabase
      .from("app_groups")
      .select("slug, name")
      .eq("id", device.group_id)
      .single();

    if (groupError) {
      throw groupError;
    }

    const { data: release, error: releaseError } = await supabase
      .from("latest_firmware_releases")
      .select("channel, version, firmware_url, checksum_sha256, notes, min_device_prefix")
      .eq("channel", channel)
      .maybeSingle();

    if (releaseError) {
      throw releaseError;
    }

    await supabase
      .from("device_firmware_status")
      .upsert({
        current_version: body.currentVersion ?? null,
        device_id: device.id,
        last_manifest_check_at: new Date().toISOString(),
        last_reported_at: new Date().toISOString(),
      });

    return json(request, 200, {
      device: {
        deviceId: device.device_uid,
        displayName: device.display_name,
        groupId: group.slug,
        groupName: group.name,
        ownerUserId: device.owner_user_id,
      },
      firmware: release ?? null,
      ok: true,
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
