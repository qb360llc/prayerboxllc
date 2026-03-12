import { createClient } from "jsr:@supabase/supabase-js@2";

type BootstrapRequest = {
  deviceId?: string;
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Headers":
      "content-type, x-client-info, x-prayerbox-bootstrap-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json",
    },
    status,
  });
}

function validateBootstrapKey(request: Request) {
  const receivedKey = request.headers.get("x-prayerbox-bootstrap-key");
  const configuredKey = Deno.env.get("PRAYERBOX_DEVICE_API_KEY");

  if (!receivedKey || !configuredKey || receivedKey !== configuredKey) {
    throw new Error("Invalid bootstrap key.");
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed.", ok: false });
  }

  try {
    validateBootstrapKey(request);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Supabase environment variables.");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const body = await request.json() as BootstrapRequest;
    const deviceId = body.deviceId?.trim();

    if (!deviceId) {
      return json(400, { error: "deviceId is required.", ok: false });
    }

    const { data: device, error: deviceError } = await supabase
      .from("devices")
      .select("id, device_uid, display_name, owner_user_id, group_id")
      .eq("device_uid", deviceId)
      .maybeSingle();

    if (deviceError) {
      throw deviceError;
    }

    if (!device) {
      return json(404, { error: "Device not provisioned yet.", ok: false });
    }

    const { data: bootstrap, error: bootstrapError } = await supabase
      .from("device_bootstrap_credentials")
      .select("device_api_key, claim_code, expires_at")
      .eq("device_id", device.id)
      .maybeSingle();

    if (bootstrapError) {
      throw bootstrapError;
    }

    if (!bootstrap?.device_api_key) {
      return json(404, {
        error: "Device bootstrap credentials are not ready. Provision the device first.",
        ok: false,
      });
    }

    if (bootstrap.expires_at && new Date(bootstrap.expires_at).getTime() < Date.now()) {
      return json(410, {
        error: "Bootstrap credentials expired. Re-provision the device.",
        ok: false,
      });
    }

    const { data: group, error: groupError } = await supabase
      .from("app_groups")
      .select("slug, name")
      .eq("id", device.group_id)
      .maybeSingle();

    if (groupError) {
      throw groupError;
    }

    await supabase
      .from("device_bootstrap_credentials")
      .update({ last_fetched_at: new Date().toISOString() })
      .eq("device_id", device.id);

    return json(200, {
      ok: true,
      device: {
        deviceId: device.device_uid,
        displayName: device.display_name,
        groupId: group?.slug ?? null,
        groupName: group?.name ?? null,
        ownerUserId: device.owner_user_id,
      },
      bootstrap: {
        claimCode: bootstrap.claim_code,
        deviceApiKey: bootstrap.device_api_key,
        expiresAt: bootstrap.expires_at,
      },
    });
  } catch (error) {
    return json(400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
