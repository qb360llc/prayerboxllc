import { createClient } from "jsr:@supabase/supabase-js@2";

type PostBody =
  | { action?: "create"; body?: string; groupSlug?: string }
  | { action: "react"; intentionId?: string; reactionType?: "like" | "love"; groupSlug?: string };

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

function isAdminProfile(profile: Record<string, unknown> | null) {
  return Boolean(profile?.is_admin);
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

  if (error) throw error;

  const fullName = [data?.first_name, data?.last_name]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(" ");

  return fullName || data?.display_name || data?.email || "Someone";
}

async function notifyGroupMembers(
  supabase: ReturnType<typeof createClient>,
  groupId: string,
  actorUserId: string,
  type: "intention_posted" | "lights_activated",
  title: string,
  body: string,
  metadata: Record<string, unknown>,
) {
  const { data: members, error } = await supabase
    .from("group_memberships")
    .select("user_id")
    .eq("group_id", groupId)
    .neq("user_id", actorUserId);

  if (error) throw error;

  if (!(members ?? []).length) return;

  const rows = (members ?? []).map((member: Record<string, unknown>) => ({
    actor_user_id: actorUserId,
    body,
    group_id: groupId,
    metadata,
    notification_type: type,
    recipient_user_id: member.user_id,
    title,
  }));

  const { error: insertError } = await supabase.from("notifications").insert(rows);
  if (insertError) throw insertError;
}

async function notifyRecipient(
  supabase: ReturnType<typeof createClient>,
  recipientUserId: string,
  actorUserId: string,
  groupId: string,
  type: "intention_loved",
  title: string,
  body: string,
  metadata: Record<string, unknown>,
) {
  if (recipientUserId === actorUserId) return;

  const { error } = await supabase.from("notifications").insert({
    actor_user_id: actorUserId,
    body,
    group_id: groupId,
    metadata,
    notification_type: type,
    recipient_user_id: recipientUserId,
    title,
  });

  if (error) throw error;
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
  if (isAdminProfile(profile)) {
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
    throw new Error("Join this community before viewing or posting intentions.");
  }

  return group;
}

async function fetchIntentions(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  group: Record<string, string>,
) {
  const { data: intentions, error: intentionsError } = await supabase
    .from("community_intentions")
    .select("id, body, created_at, created_by_user_id")
    .eq("group_id", group.id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (intentionsError) {
    throw intentionsError;
  }

  const intentionIds = (intentions ?? []).map((item: Record<string, unknown>) => String(item.id));
  const authorIds = Array.from(
    new Set((intentions ?? []).map((item: Record<string, unknown>) => String(item.created_by_user_id))),
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

    if (authorsError) {
      throw authorsError;
    }

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

  let reactionsByIntention = new Map<string, { likeCount: number; loveCount: number; userReaction: string | null }>();
  if (intentionIds.length) {
    const { data: reactions, error: reactionsError } = await supabase
      .from("community_intention_reactions")
      .select("intention_id, user_id, reaction_type")
      .in("intention_id", intentionIds);

    if (reactionsError) {
      throw reactionsError;
    }

    reactionsByIntention = new Map(
      intentionIds.map((id) => [id, { likeCount: 0, loveCount: 0, userReaction: null }]),
    );

    (reactions ?? []).forEach((reaction: Record<string, unknown>) => {
      const intentionId = String(reaction.intention_id);
      const bucket = reactionsByIntention.get(intentionId) ?? { likeCount: 0, loveCount: 0, userReaction: null };
      const reactionType = String(reaction.reaction_type);
      if (reactionType === "like") bucket.likeCount += 1;
      if (reactionType === "love") bucket.loveCount += 1;
      if (String(reaction.user_id) === userId) {
        bucket.userReaction = reactionType;
      }
      reactionsByIntention.set(intentionId, bucket);
    });
  }

  return (intentions ?? []).map((item: Record<string, unknown>) => {
    const profile = authorsById.get(String(item.created_by_user_id)) ?? null;
    const fullName = [profile?.first_name, profile?.last_name]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean)
      .join(" ");
    const reactionState = reactionsByIntention.get(String(item.id)) ?? {
      likeCount: 0,
      loveCount: 0,
      userReaction: null,
    };

    return {
      body: item.body,
      createdAt: item.created_at,
      createdBy: fullName || profile?.display_name || profile?.email || "Community member",
      createdByUserId: item.created_by_user_id,
      id: item.id,
      likeCount: reactionState.likeCount,
      loveCount: reactionState.loveCount,
      userReaction: reactionState.userReaction,
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
      const intentions = await fetchIntentions(supabase, user.id, group);

      return json(request, 200, {
        group: {
          groupId: group.id,
          name: group.name,
          slug: group.slug,
        },
        intentions,
        ok: true,
      });
    }

    if (request.method !== "POST") {
      return json(request, 405, { error: "Method not allowed.", ok: false });
    }

    const body = await request.json() as PostBody;
    const action = body.action ?? "create";
    const groupSlug = body.groupSlug?.trim();
    if (!groupSlug) {
      return json(request, 400, { error: "groupSlug is required.", ok: false });
    }

    const group = await getGroupForUser(supabase, user.id, groupSlug);

    if (action === "create") {
      const intentionBody = body.body?.trim();
      if (!intentionBody) {
        return json(request, 400, { error: "Prayer or intention text is required.", ok: false });
      }

      const { data: insertedIntention, error: insertError } = await supabase
        .from("community_intentions")
        .insert({
          body: intentionBody,
          created_by_user_id: user.id,
          group_id: group.id,
        })
        .select("id")
        .single();

      if (insertError) {
        throw insertError;
      }

      const actorName = await getActorName(supabase, user.id);
      await notifyGroupMembers(
        supabase,
        group.id,
        user.id,
        "intention_posted",
        "New prayer intention",
        `${actorName} shared a new intention in ${group.name}.`,
        {
          intentionId: insertedIntention.id,
          groupSlug: group.slug,
        },
      );
    } else if (action === "react") {
      const intentionId = body.intentionId?.trim();
      const reactionType = body.reactionType;

      if (!intentionId || !reactionType || !["like", "love"].includes(reactionType)) {
        return json(request, 400, { error: "intentionId and a valid reactionType are required.", ok: false });
      }

      const { data: intention, error: intentionError } = await supabase
        .from("community_intentions")
        .select("id, group_id")
        .eq("id", intentionId)
        .maybeSingle();

      if (intentionError) {
        throw intentionError;
      }

      if (!intention || intention.group_id !== group.id) {
        return json(request, 404, { error: "Unknown intention for this group.", ok: false });
      }

      const { data: existingReaction, error: existingError } = await supabase
        .from("community_intention_reactions")
        .select("id, reaction_type")
        .eq("intention_id", intentionId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (existingError) {
        throw existingError;
      }

      if (existingReaction?.reaction_type === reactionType) {
        const { error: deleteError } = await supabase
          .from("community_intention_reactions")
          .delete()
          .eq("id", existingReaction.id);

        if (deleteError) {
          throw deleteError;
        }
      } else if (existingReaction) {
        const { error: updateError } = await supabase
          .from("community_intention_reactions")
          .update({ reaction_type: reactionType })
          .eq("id", existingReaction.id);

        if (updateError) {
          throw updateError;
        }
      } else {
        const { error: insertReactionError } = await supabase
          .from("community_intention_reactions")
          .insert({
            intention_id: intentionId,
            reaction_type: reactionType,
            user_id: user.id,
          });

        if (insertReactionError) {
          throw insertReactionError;
        }
      }

      if (reactionType === "love" && existingReaction?.reaction_type !== "love") {
        const actorName = await getActorName(supabase, user.id);
        const { data: targetIntention, error: targetIntentionError } = await supabase
          .from("community_intentions")
          .select("created_by_user_id, body")
          .eq("id", intentionId)
          .single();

        if (targetIntentionError) throw targetIntentionError;

        const intentionPreview = String(targetIntention.body)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);

        await notifyRecipient(
          supabase,
          targetIntention.created_by_user_id,
          user.id,
          group.id,
          "intention_loved",
          `${actorName} loved your intention`,
          `${actorName} loved your intention in ${group.name}: "${intentionPreview}${String(targetIntention.body).length > intentionPreview.length ? "..." : ""}"`,
          {
            groupSlug: group.slug,
            intentionId,
            preview: intentionPreview,
          },
        );
      }
    } else {
      return json(request, 400, { error: "Unknown action.", ok: false });
    }

    const intentions = await fetchIntentions(supabase, user.id, group);
    return json(request, 200, {
      group: {
        groupId: group.id,
        name: group.name,
        slug: group.slug,
      },
      intentions,
      ok: true,
    });
  } catch (error) {
    return json(request, 400, {
      error: errorMessage(error),
      ok: false,
    });
  }
});
