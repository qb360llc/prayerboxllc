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

type ReleaseInput = {
  channel?: string;
  checksumSha256?: string | null;
  firmwareUrl?: string;
  isActive?: boolean;
  minDevicePrefix?: string | null;
  notes?: string | null;
  version?: string;
};

function normalizeSha256(value: string) {
  return value.trim().toLowerCase();
}

function isValidSha256(value: string) {
  return /^[a-f0-9]{64}$/.test(value);
}

async function getAuthedUser(request: Request) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { supabase: createClient(supabaseUrl, serviceRoleKey), user: null };
  }

  const jwt = authHeader.replace("Bearer ", "");
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await supabase.auth.getUser(jwt);

  if (error) {
    throw error;
  }

  return { supabase, user: data.user };
}

async function assertAdmin(
  supabase: ReturnType<typeof createClient>,
  userId: string,
) {
  const { data, error } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data?.is_admin) {
    throw new Error("Admin access required.");
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  if (!["GET", "POST"].includes(request.method)) {
    return json(request, 405, { error: "Method not allowed." });
  }

  try {
    const { supabase, user } = await getAuthedUser(request);
    if (!user) {
      return json(request, 401, { error: "Missing or invalid bearer token." });
    }

    if (request.method === "GET") {
      const { data, error } = await supabase
        .from("firmware_releases")
        .select("id, channel, version, firmware_url, checksum_sha256, notes, min_device_prefix, is_active, created_at")
        .order("created_at", { ascending: false });

      if (error) {
        throw error;
      }

      return json(request, 200, {
        ok: true,
        releases: data ?? [],
      });
    }

    await assertAdmin(supabase, user.id);

    const body = await request.json() as ReleaseInput;
    const version = body.version?.trim();
    const firmwareUrl = body.firmwareUrl?.trim();
    const channel = body.channel?.trim() || "stable";
    const checksumSha256 = normalizeSha256(body.checksumSha256?.trim() || "");

    if (!version || !firmwareUrl || !checksumSha256) {
      return json(request, 400, {
        error: "version, firmwareUrl, and checksumSha256 are required.",
      });
    }

    if (!isValidSha256(checksumSha256)) {
      return json(request, 400, {
        error: "checksumSha256 must be a 64-character lowercase SHA-256 hex string.",
      });
    }

    if (body.isActive) {
      const { error: deactivateError } = await supabase
        .from("firmware_releases")
        .update({ is_active: false })
        .eq("channel", channel)
        .eq("is_active", true);

      if (deactivateError) {
        throw deactivateError;
      }
    }

    const { data, error } = await supabase
      .from("firmware_releases")
      .insert({
        channel,
        checksum_sha256: checksumSha256,
        firmware_url: firmwareUrl,
        is_active: body.isActive ?? true,
        min_device_prefix: body.minDevicePrefix?.trim() || null,
        notes: body.notes?.trim() || null,
        version,
      })
      .select("id, channel, version, firmware_url, checksum_sha256, notes, min_device_prefix, is_active, created_at")
      .single();

    if (error) {
      throw error;
    }

    return json(request, 200, {
      ok: true,
      release: data,
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
