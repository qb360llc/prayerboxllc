import { createClient } from "jsr:@supabase/supabase-js@2";

type ProvisionRequest = {
  allowReclaim?: boolean;
  claimTtlHours?: number;
  deviceId?: string;
  displayName?: string;
  groupId?: string;
  rotateClaimCode?: boolean;
  rotateDeviceKey?: boolean;
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

async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function randomClaimCode() {
  return `PBX-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

async function getAuthedAdmin(request: Request) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token.");
  }

  const jwt = authHeader.replace("Bearer ", "");
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  if (userError) {
    throw userError;
  }

  const user = userData.user;
  if (!user) {
    throw new Error("Invalid user token.");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    throw profileError;
  }

  if (!profile?.is_admin) {
    throw new Error("Admin access required.");
  }

  return { supabase, user };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  if (request.method !== "POST") {
    return json(request, 405, { error: "Method not allowed." });
  }

  try {
    const { supabase } = await getAuthedAdmin(request);
    const body = await request.json() as ProvisionRequest;
    const deviceUid = body.deviceId?.trim();
    const groupSlug = body.groupId?.trim() || "main";
    const displayName = body.displayName?.trim() || deviceUid;
    const claimTtlHours = Math.max(1, Math.min(body.claimTtlHours ?? 168, 24 * 30));
    const rotateClaimCode = body.rotateClaimCode ?? true;
    const rotateDeviceKey = body.rotateDeviceKey ?? true;
    const allowReclaim = body.allowReclaim ?? false;

    if (!deviceUid) {
      return json(request, 400, { error: "deviceId is required." });
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
      throw new Error(`Unknown group slug: ${groupSlug}`);
    }

    const { data: existingDevice, error: deviceError } = await supabase
      .from("devices")
      .select("id, device_uid, display_name, owner_user_id")
      .eq("device_uid", deviceUid)
      .maybeSingle();

    if (deviceError) {
      throw deviceError;
    }

    let device = existingDevice;
    if (!device) {
      const { data: insertedDevice, error: insertDeviceError } = await supabase
        .from("devices")
        .insert({
          device_uid: deviceUid,
          display_name: displayName || deviceUid,
          group_id: group.id,
        })
        .select("id, device_uid, display_name, owner_user_id")
        .single();

      if (insertDeviceError) {
        throw insertDeviceError;
      }

      device = insertedDevice;
    } else {
      const { error: updateDeviceError } = await supabase
        .from("devices")
        .update({
          display_name: displayName || existingDevice.display_name,
          group_id: group.id,
        })
        .eq("id", existingDevice.id);

      if (updateDeviceError) {
        throw updateDeviceError;
      }
    }

    if (device.owner_user_id && !allowReclaim) {
      throw new Error("Device is already claimed. Enable allowReclaim to rotate provisioning.");
    }

    let claimCode: string | null = null;
    let claimExpiresAt: string | null = null;
    if (rotateClaimCode) {
      claimCode = randomClaimCode();
      claimExpiresAt = new Date(Date.now() + claimTtlHours * 60 * 60 * 1000).toISOString();

      const { error: claimError } = await supabase
        .from("device_claim_codes")
        .upsert({
          claimed_at: null,
          claimed_by_user_id: null,
          claim_code: claimCode,
          device_id: device.id,
          expires_at: claimExpiresAt,
        }, {
          onConflict: "device_id",
        });

      if (claimError) {
        throw claimError;
      }
    }

    let deviceApiKey: string | null = null;
    if (rotateDeviceKey) {
      deviceApiKey = randomToken("pbxdev");
      const keyHash = await sha256Hex(deviceApiKey);

      const { error: keyError } = await supabase
        .from("device_api_keys")
        .upsert({
          device_id: device.id,
          key_hash: keyHash,
          rotated_at: new Date().toISOString(),
        });

      if (keyError) {
        throw keyError;
      }
    }

    return json(request, 200, {
      ok: true,
      provisioning: {
        claimCode,
        claimExpiresAt,
        deviceApiKey,
      },
      device: {
        deviceId: device.device_uid,
        displayName: displayName || device.display_name,
        groupId: group.slug,
        groupName: group.name,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unknown error")
        : JSON.stringify(error);

    return json(request, 400, {
      error: errorMessage,
      ok: false,
    });
  }
});
