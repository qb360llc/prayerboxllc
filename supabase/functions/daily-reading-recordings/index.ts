import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPushToUsers } from "../_shared/web-push.ts";

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

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return "Unknown error";
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

async function getProfile(supabase: ReturnType<typeof createClient>, userId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function getActorName(
  supabase: ReturnType<typeof createClient>,
  userId: string,
) {
  const { data, error } = await supabase
    .from("profiles")
    .select("first_name, last_name, display_name, email")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const fullName = [data?.first_name, data?.last_name]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(" ");

  return fullName || data?.display_name || data?.email || "Someone";
}

async function getGroupForUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  groupSlug: string,
) {
  const { data: group, error: groupError } = await supabase
    .from("app_groups")
    .select("id, slug, name")
    .eq("slug", groupSlug)
    .maybeSingle();

  if (groupError) {
    throw groupError;
  }

  if (!group) {
    throw new Error("Unknown group.");
  }

  const profile = await getProfile(supabase, userId);
  if (profile?.is_admin) {
    return group;
  }

  const { data: membership, error: membershipError } = await supabase
    .from("group_memberships")
    .select("id")
    .eq("group_id", group.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (membershipError) {
    throw membershipError;
  }

  if (!membership) {
    throw new Error("Join this group before viewing or sharing recordings.");
  }

  return group;
}

async function notifyGroupMembers(
  supabase: ReturnType<typeof createClient>,
  groupId: string,
  actorUserId: string,
  title: string,
  body: string,
  metadata: Record<string, unknown>,
) {
  const { data: members, error } = await supabase
    .from("group_memberships")
    .select("user_id")
    .eq("group_id", groupId)
    .neq("user_id", actorUserId);

  if (error) {
    throw error;
  }

  const recipientUserIds = (members ?? []).map((member: Record<string, unknown>) => String(member.user_id));
  if (!recipientUserIds.length) {
    return {
      attempted: 0,
      failed: 0,
      failures: [],
      sent: 0,
    };
  }

  const rows = recipientUserIds.map((recipientUserId) => ({
    actor_user_id: actorUserId,
    body,
    group_id: groupId,
    metadata,
    notification_type: "daily_reading_uploaded",
    recipient_user_id: recipientUserId,
    title,
  }));

  const { error: insertError } = await supabase.from("notifications").insert(rows);
  if (insertError) {
    throw insertError;
  }

  return await sendPushToUsers(supabase, recipientUserIds, {
    body,
    data: {
      groupId,
      type: "daily_reading_uploaded",
      url: "/readings.html",
      ...metadata,
    },
    tag: `daily-reading-${groupId}-${crypto.randomUUID()}`,
    title,
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  try {
    const supabase = await getSupabase();

    if (request.method === "GET") {
      const user = await getAuthedUser(request, supabase);
      const url = new URL(request.url);
      const readingDate = normalizeReadingDate(url.searchParams.get("readingDate"));
      const groupSlug = url.searchParams.get("groupSlug")?.trim();

      if (!groupSlug) {
        return json(request, 400, { error: "groupSlug is required.", ok: false });
      }

      const group = await getGroupForUser(supabase, user.id, groupSlug);

      const { data: row, error } = await supabase
        .from("daily_reading_recordings")
        .select("id, reading_date, created_at, created_by_user_id, storage_path")
        .eq("group_id", group.id)
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
          groupSlug: group.slug,
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
    const groupSlug = form.get("groupSlug")?.toString().trim() ?? "";
    const durationMs = Number.parseInt(form.get("durationMs")?.toString() ?? "", 10);

    if (!(file instanceof File)) {
      return json(request, 400, { error: "audio file is required.", ok: false });
    }

    if (!groupSlug) {
      return json(request, 400, { error: "groupSlug is required.", ok: false });
    }

    const group = await getGroupForUser(supabase, user.id, groupSlug);

    const extension = file.name.includes(".") ? file.name.split(".").pop() : "webm";
    const safeExtension = (extension || "webm").replace(/[^a-z0-9]/gi, "").toLowerCase() || "webm";
    const storagePath = `${group.slug}/${readingDate}/${crypto.randomUUID()}.${safeExtension}`;

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
        group_id: group.id,
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

    const actorName = await getActorName(supabase, user.id);
    const pushResult = await notifyGroupMembers(
      supabase,
      group.id,
      user.id,
      "New daily reading recording",
      `${actorName} uploaded a new daily reading recording in ${group.name}.`,
      {
        groupName: group.name,
        groupSlug: group.slug,
        readingDate,
      },
    );

    return json(request, 200, {
      ok: true,
      pushResult,
      recording: {
        audioUrl: signed.signedUrl,
        createdAt: inserted.created_at,
        groupSlug: group.slug,
        id: inserted.id,
        readingDate: inserted.reading_date,
      },
    });
  } catch (error) {
    return json(request, 400, {
      error: errorMessage(error),
      ok: false,
    });
  }
});
