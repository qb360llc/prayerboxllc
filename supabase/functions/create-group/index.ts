import { createClient } from "jsr:@supabase/supabase-js@2";

type CreateGroupRequest = {
  name?: string;
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

function slugify(name: string) {
  const normalized = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  return normalized || "community";
}

function randomSuffix() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 6);
}

function randomInviteCode() {
  return `GRP-${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  if (request.method !== "POST") {
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

    const body = await request.json() as CreateGroupRequest;
    const name = body.name?.trim();
    if (!name) {
      return json(request, 400, { error: "name is required.", ok: false });
    }

    const slug = `${slugify(name)}-${randomSuffix()}`;
    const inviteCode = randomInviteCode();

    const { data: group, error: groupError } = await supabase
      .from("app_groups")
      .insert({
        created_by_user_id: user.id,
        invite_code: inviteCode,
        name,
        slug,
      })
      .select("id, slug, name, invite_code")
      .single();

    if (groupError) {
      throw groupError;
    }

    const { error: membershipError } = await supabase
      .from("group_memberships")
      .insert({
        group_id: group.id,
        role: "owner",
        user_id: user.id,
      });

    if (membershipError) {
      throw membershipError;
    }

    return json(request, 200, {
      group: {
        groupId: group.id,
        inviteCode: group.invite_code,
        name: group.name,
        role: "owner",
        slug: group.slug,
      },
      ok: true,
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
