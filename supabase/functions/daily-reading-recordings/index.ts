import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "daily-readings-audio";

function corsHeaders(request: Request) {
  const allowedOrigin = Deno.env.get("PRAYERBOX_PORTAL_ORIGIN");
  const requestOrigin = request.headers.get("Origin");
  const origin = allowedOrigin
    ? (requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin)
    : "*";

  return {
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
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

function normalizeReadingDate(input?: string | null) {
  const value = input?.trim();
  if (!value) {
    return new Date().toISOString().slice(0, 10);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("readingDate must be YYYY-MM-DD.");
  }

  return value;
}

async function getSupabase() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

async function getAuthedUser(request: Request, supabase: ReturnType<typeof createClient>) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token.");
  }

  const jwt = authHeader.replace("Bearer ", "");
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error) {
    throw error;
  }

  if (!data.user) {
    throw new Error("Invalid user token.");
  }

  return data.user;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  try {
    const supabase = await getSupabase();

    if (request.method === "GET") {
      const url = new URL(request.url);
      const readingDate = normalizeReadingDate(url.searchParams.get("readingDate"));

      const { data: row, error } = await supabase
        .from("daily_reading_recordings")
        .select("id, reading_date, created_at, created_by_user_id, storage_path")
        .eq("reading_date", readingDate)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!row) {
        return json(request, 200, { ok: true, recording: null });
      }

      const { data: signed, error: signedError } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(row.storage_path, 60 * 60);

      if (signedError) {
        throw signedError;
      }

      return json(request, 200, {
        ok: true,
        recording: {
          audioUrl: signed.signedUrl,
          createdAt: row.created_at,
          createdByUserId: row.created_by_user_id,
          id: row.id,
          readingDate: row.reading_date,
        },
      });
    }

    if (request.method !== "POST") {
      return json(request, 405, { error: "Method not allowed.", ok: false });
    }

    const user = await getAuthedUser(request, supabase);
    const form = await request.formData();
    const file = form.get("audio");
    const readingDate = normalizeReadingDate(form.get("readingDate")?.toString() ?? null);
    const durationMs = Number.parseInt(form.get("durationMs")?.toString() ?? "", 10);

    if (!(file instanceof File)) {
      return json(request, 400, { error: "audio file is required.", ok: false });
    }

    const extension = file.name.includes(".") ? file.name.split(".").pop() : "webm";
    const safeExtension = (extension || "webm").replace(/[^a-z0-9]/gi, "").toLowerCase() || "webm";
    const storagePath = `${readingDate}/${crypto.randomUUID()}.${safeExtension}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file, {
        cacheControl: "3600",
        contentType: file.type || "audio/webm",
        upsert: false,
      });

    if (uploadError) {
      throw uploadError;
    }

    const { data: inserted, error: insertError } = await supabase
      .from("daily_reading_recordings")
      .insert({
        content_type: file.type || "audio/webm",
        created_by_user_id: user.id,
        duration_ms: Number.isFinite(durationMs) ? durationMs : null,
        reading_date: readingDate,
        storage_path: storagePath,
      })
      .select("id, reading_date, created_at")
      .single();

    if (insertError) {
      throw insertError;
    }

    const { data: signed, error: signedError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, 60 * 60);

    if (signedError) {
      throw signedError;
    }

    return json(request, 200, {
      ok: true,
      recording: {
        audioUrl: signed.signedUrl,
        createdAt: inserted.created_at,
        id: inserted.id,
        readingDate: inserted.reading_date,
      },
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
