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

    const { data: memberships, error } = await supabase
      .from("group_memberships")
      .select(`
        role,
        created_at,
        app_groups!inner (
          id,
          slug,
          name,
          invite_code,
          created_by_user_id
        )
      `)
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });

    if (error) {
      throw error;
    }

    const groups = (memberships ?? []).map((row: Record<string, unknown>) => {
      const group = row.app_groups as Record<string, unknown>;
      const role = String(row.role ?? "member");
      const canManage = role === "owner" || role === "admin";

      return {
        createdAt: row.created_at,
        groupId: group.id,
        inviteCode: group.invite_code,
        name: group.name,
        role,
        slug: group.slug,
        canManage,
      };
    });

    return json(request, 200, {
      groups,
      ok: true,
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
