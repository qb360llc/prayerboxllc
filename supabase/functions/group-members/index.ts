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

function displayName(profile: Record<string, unknown> | undefined, userId: string) {
  const fullName = [profile?.first_name, profile?.last_name]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .trim();

  if (fullName) return fullName;
  if (typeof profile?.display_name === "string" && profile.display_name.trim()) {
    return profile.display_name.trim();
  }
  if (typeof profile?.email === "string" && profile.email.trim()) {
    return profile.email.trim();
  }
  return userId;
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

    const groupSlug = new URL(request.url).searchParams.get("groupSlug")?.trim();
    if (!groupSlug) {
      return json(request, 400, { error: "groupSlug is required.", ok: false });
    }

    const jwt = authHeader.replace("Bearer ", "");
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt);

    if (userError) throw userError;

    const user = userData.user;
    if (!user) {
      return json(request, 401, { error: "Invalid user token.", ok: false });
    }

    const { data: group, error: groupError } = await supabase
      .from("app_groups")
      .select("id, slug, name")
      .eq("slug", groupSlug)
      .maybeSingle();

    if (groupError) throw groupError;
    if (!group) {
      return json(request, 404, { error: "Community not found.", ok: false });
    }

    const { data: membership, error: membershipError } = await supabase
      .from("group_memberships")
      .select("id")
      .eq("group_id", group.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (membershipError) throw membershipError;
    if (!membership) {
      return json(request, 403, { error: "You are not a member of this community.", ok: false });
    }

    const { data: memberships, error } = await supabase
      .from("group_memberships")
      .select("user_id, role, created_at")
      .eq("group_id", group.id)
      .order("created_at", { ascending: true });

    if (error) throw error;

    const userIds = [...new Set((memberships ?? []).map((row) => String(row.user_id)))];
    const profilesById = new Map<string, Record<string, unknown>>();

    if (userIds.length) {
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, first_name, last_name, display_name, email, avatar_url")
        .in("id", userIds);

      if (profilesError) throw profilesError;

      (profiles ?? []).forEach((profile: Record<string, unknown>) => {
        if (typeof profile.id === "string") {
          profilesById.set(profile.id, profile);
        }
      });
    }

    const members = (memberships ?? []).map((row: Record<string, unknown>) => {
      const userId = String(row.user_id ?? "");
      const profile = profilesById.get(userId);

      return {
        avatarUrl: typeof profile?.avatar_url === "string" ? profile.avatar_url : null,
        createdAt: row.created_at,
        firstName: typeof profile?.first_name === "string" ? profile.first_name : null,
        lastName: typeof profile?.last_name === "string" ? profile.last_name : null,
        name: displayName(profile, userId),
        role: typeof row.role === "string" ? row.role : "member",
        userId,
      };
    });

    return json(request, 200, {
      group: {
        groupId: group.id,
        name: group.name,
        slug: group.slug,
      },
      members,
      ok: true,
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
