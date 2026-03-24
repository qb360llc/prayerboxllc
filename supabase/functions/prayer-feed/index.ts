import { createClient } from "jsr:@supabase/supabase-js@2";

type FeedItem =
  | {
    id: string;
    type: "intention";
    createdAt: string;
    createdBy: string;
    avatarUrl?: string | null;
    body: string;
  }
  | {
    id: string;
    type: "prayer_event";
    createdAt: string;
    createdBy: string;
    avatarUrl?: string | null;
    eventType: "entered" | "left";
    body: string;
  };

function corsHeaders(request: Request) {
  const allowedOrigin = Deno.env.get("PRAYERBOX_PORTAL_ORIGIN");
  const requestOrigin = request.headers.get("Origin");
  const origin = allowedOrigin
    ? (requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin)
    : "*";

  return {
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
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

function profileName(profile: Record<string, unknown> | undefined) {
  const fullName = [profile?.first_name, profile?.last_name]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(" ");

  return fullName || String(profile?.display_name || profile?.email || "Community member");
}

function profileAvatar(profile: Record<string, unknown> | undefined) {
  return typeof profile?.avatar_url === "string" ? profile.avatar_url.trim() : null;
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

    const url = new URL(request.url);
    const groupSlug = url.searchParams.get("groupSlug")?.trim();
    if (!groupSlug) {
      return json(request, 400, { error: "groupSlug is required.", ok: false });
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
      return json(request, 404, { error: "Unknown group.", ok: false });
    }

    const { data: membership, error: membershipError } = await supabase
      .from("group_memberships")
      .select("id")
      .eq("group_id", group.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (membershipError) {
      throw membershipError;
    }

    if (!membership) {
      return json(request, 403, { error: "Join this community before viewing the prayer feed.", ok: false });
    }

    const { data: intentions, error: intentionsError } = await supabase
      .from("community_intentions")
      .select("id, body, created_at, created_by_user_id")
      .eq("group_id", group.id)
      .order("created_at", { ascending: false })
      .limit(60);

    if (intentionsError) {
      throw intentionsError;
    }

    const { data: prayerEvents, error: prayerEventsError } = await supabase
      .from("prayer_presence_events")
      .select("id, event_type, created_at, user_id")
      .eq("group_id", group.id)
      .order("created_at", { ascending: false })
      .limit(60);

    if (prayerEventsError) {
      throw prayerEventsError;
    }

    const authorIds = Array.from(new Set([
      ...(intentions ?? []).map((item: Record<string, unknown>) => String(item.created_by_user_id)),
      ...(prayerEvents ?? []).map((item: Record<string, unknown>) => String(item.user_id)),
    ]));

    const authorsById = new Map<string, Record<string, unknown>>();
    if (authorIds.length) {
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, first_name, last_name, display_name, email, avatar_url")
        .in("id", authorIds);

      if (profilesError) {
        throw profilesError;
      }

      for (const profile of profiles ?? []) {
        authorsById.set(String((profile as Record<string, unknown>).id), profile as Record<string, unknown>);
      }
    }

    const feedItems: FeedItem[] = [
      ...(intentions ?? []).map((item: Record<string, unknown>) => ({
        avatarUrl: profileAvatar(authorsById.get(String(item.created_by_user_id))),
        body: String(item.body || ""),
        createdAt: String(item.created_at),
        createdBy: profileName(authorsById.get(String(item.created_by_user_id))),
        id: `intention:${String(item.id)}`,
        type: "intention" as const,
      })),
      ...(prayerEvents ?? []).map((item: Record<string, unknown>) => {
        const name = profileName(authorsById.get(String(item.user_id)));
        const eventType = String(item.event_type) === "left" ? "left" : "entered";
        return {
          avatarUrl: profileAvatar(authorsById.get(String(item.user_id))),
          body: eventType === "left"
            ? `${name} has finished praying`
            : `${name} has entered prayer`,
          createdAt: String(item.created_at),
          createdBy: name,
          eventType,
          id: `prayer-event:${String(item.id)}`,
          type: "prayer_event" as const,
        };
      }),
    ]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 100);

    return json(request, 200, {
      ok: true,
      group: {
        groupId: group.id,
        name: group.name,
        slug: group.slug,
      },
      items: feedItems,
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
