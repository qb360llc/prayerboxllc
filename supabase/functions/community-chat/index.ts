import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "community-chat-audio";

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
  if (error) throw error;
  if (!data.user) throw new Error("Invalid user token.");
  return data.user;
}

async function getProfile(supabase: ReturnType<typeof createClient>, userId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
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

  if (groupError) throw groupError;
  if (!group) throw new Error("Unknown group.");

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

  if (membershipError) throw membershipError;
  if (!membership) throw new Error("Join this community before using chat.");

  return group;
}

async function fetchMessages(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  group: Record<string, string>,
) {
  const { data: messages, error: messagesError } = await supabase
    .from("community_messages")
    .select("id, message_type, body, storage_path, content_type, duration_ms, created_at, created_by_user_id")
    .eq("group_id", group.id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (messagesError) throw messagesError;

  const orderedMessages = [...(messages ?? [])].reverse();
  const authorIds = Array.from(
    new Set(orderedMessages.map((item: Record<string, unknown>) => String(item.created_by_user_id))),
  );

  let authorsById = new Map<
    string,
    {
      display_name?: string | null;
      email?: string | null;
      first_name?: string | null;
      last_name?: string | null;
    }
  >();

  if (authorIds.length) {
    const { data: authors, error: authorsError } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, display_name, email")
      .in("id", authorIds);

    if (authorsError) throw authorsError;

    authorsById = new Map(
      (authors ?? []).map((author: Record<string, unknown>) => [
        String(author.id),
        {
          display_name: typeof author.display_name === "string" ? author.display_name : null,
          email: typeof author.email === "string" ? author.email : null,
          first_name: typeof author.first_name === "string" ? author.first_name : null,
          last_name: typeof author.last_name === "string" ? author.last_name : null,
        },
      ]),
    );
  }

  const signedAudio = new Map<string, string>();
  await Promise.all(
    orderedMessages
      .filter((item: Record<string, unknown>) => typeof item.storage_path === "string" && item.storage_path)
      .map(async (item: Record<string, unknown>) => {
        const storagePath = String(item.storage_path);
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60);
        if (error) throw error;
        signedAudio.set(String(item.id), data.signedUrl);
      }),
  );

  return orderedMessages.map((item: Record<string, unknown>) => {
    const profile = authorsById.get(String(item.created_by_user_id)) ?? null;
    const fullName = [profile?.first_name, profile?.last_name]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean)
      .join(" ");

    return {
      audioUrl: signedAudio.get(String(item.id)) || null,
      body: item.body,
      contentType: item.content_type,
      createdAt: item.created_at,
      createdBy: fullName || profile?.display_name || profile?.email || "Community member",
      durationMs: item.duration_ms,
      id: item.id,
      isOwn: String(item.created_by_user_id) === userId,
      messageType: item.message_type,
    };
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  try {
    const supabase = await getSupabase();
    const user = await getAuthedUser(request, supabase);

    if (request.method === "GET") {
      const url = new URL(request.url);
      const groupSlug = url.searchParams.get("groupSlug")?.trim();
      if (!groupSlug) {
        return json(request, 400, { error: "groupSlug is required.", ok: false });
      }

      const group = await getGroupForUser(supabase, user.id, groupSlug);
      const messages = await fetchMessages(supabase, user.id, group);

      return json(request, 200, {
        group: {
          groupId: group.id,
          name: group.name,
          slug: group.slug,
        },
        messages,
        ok: true,
      });
    }

    if (request.method !== "POST") {
      return json(request, 405, { error: "Method not allowed.", ok: false });
    }

    const contentType = request.headers.get("Content-Type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("audio");
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
      const storagePath = `${group.slug}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${safeExtension}`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file, {
          cacheControl: "3600",
          contentType: file.type || "audio/webm",
          upsert: false,
        });

      if (uploadError) throw uploadError;

      const { error: insertError } = await supabase
        .from("community_messages")
        .insert({
          content_type: file.type || "audio/webm",
          created_by_user_id: user.id,
          duration_ms: Number.isFinite(durationMs) ? durationMs : null,
          group_id: group.id,
          message_type: "audio",
          storage_path: storagePath,
        });

      if (insertError) throw insertError;

      const messages = await fetchMessages(supabase, user.id, group);
      return json(request, 200, {
        group: {
          groupId: group.id,
          name: group.name,
          slug: group.slug,
        },
        messages,
        ok: true,
      });
    }

    const body = await request.json() as { body?: string; groupSlug?: string };
    const groupSlug = body.groupSlug?.trim();
    const messageBody = body.body?.trim();

    if (!groupSlug) {
      return json(request, 400, { error: "groupSlug is required.", ok: false });
    }
    if (!messageBody) {
      return json(request, 400, { error: "Message text is required.", ok: false });
    }

    const group = await getGroupForUser(supabase, user.id, groupSlug);
    const { error: insertError } = await supabase
      .from("community_messages")
      .insert({
        body: messageBody,
        created_by_user_id: user.id,
        group_id: group.id,
        message_type: "text",
      });

    if (insertError) throw insertError;

    const messages = await fetchMessages(supabase, user.id, group);
    return json(request, 200, {
      group: {
        groupId: group.id,
        name: group.name,
        slug: group.slug,
      },
      messages,
      ok: true,
    });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
