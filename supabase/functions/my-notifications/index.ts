import { createClient } from "jsr:@supabase/supabase-js@2";

type MarkReadRequest = {
  markAll?: boolean;
  notificationId?: string;
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

async function loadNotifications(
  supabase: ReturnType<typeof createClient>,
  userId: string,
) {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, title, body, notification_type, metadata, created_at, read_at")
    .eq("recipient_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  const unreadCount = (data ?? []).filter((row: Record<string, unknown>) => !row.read_at).length;

  return {
    notifications: (data ?? []).map((row: Record<string, unknown>) => ({
      body: row.body,
      createdAt: row.created_at,
      id: row.id,
      isRead: Boolean(row.read_at),
      metadata: row.metadata ?? {},
      readAt: row.read_at,
      title: row.title,
      type: row.notification_type,
    })),
    unreadCount,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  try {
    const supabase = await getSupabase();
    const user = await getAuthedUser(request, supabase);

    if (request.method === "GET") {
      const payload = await loadNotifications(supabase, user.id);
      return json(request, 200, { ok: true, ...payload });
    }

    if (request.method !== "POST") {
      return json(request, 405, { error: "Method not allowed.", ok: false });
    }

    const body = await request.json() as MarkReadRequest;
    const now = new Date().toISOString();
    if (body.markAll) {
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: now })
        .eq("recipient_user_id", user.id)
        .is("read_at", null);

      if (error) throw error;
    } else if (body.notificationId?.trim()) {
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: now })
        .eq("id", body.notificationId.trim())
        .eq("recipient_user_id", user.id);

      if (error) throw error;
    } else {
      return json(request, 400, { error: "notificationId or markAll is required.", ok: false });
    }

    const payload = await loadNotifications(supabase, user.id);
    return json(request, 200, { ok: true, ...payload });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
