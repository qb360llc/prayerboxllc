import { createClient } from "jsr:@supabase/supabase-js@2";

type FeedItem =
  | {
    id: string;
    type: "intention";
    intentionId: string;
    createdAt: string;
    createdBy: string;
    avatarUrl?: string | null;
    body: string;
    amenCount: number;
    userHasAmen: boolean;
    commentCount: number;
  }
  | {
    id: string;
    type: "reading_upload";
    createdAt: string;
    createdBy: string;
    avatarUrl?: string | null;
    body: string;
    readingDate: string;
  }
  | {
    id: string;
    type: "group_prayer_event";
    createdAt: string;
    createdBy: string;
    avatarUrl?: string | null;
    body: string;
    eventKey: string;
    eventType: "scheduled" | "reminder" | "start";
    amenCount: number;
    userHasAmen: boolean;
  }
  | {
    id: string;
    type: "prayer_event";
    createdAt: string;
    createdBy: string;
    avatarUrl?: string | null;
    eventKey: string;
    eventType: "entered" | "left";
    body: string;
    amenCount: number;
    userHasAmen: boolean;
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

  if (!["GET", "POST"].includes(request.method)) {
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

    const requestBody = request.method === "POST"
      ? await request.json().catch(() => ({})) as Record<string, unknown>
      : {};

    const url = new URL(request.url);
    const groupSlug = url.searchParams.get("groupSlug")?.trim()
      || String(requestBody.groupSlug || "").trim();
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

    if (request.method === "POST") {
      const eventKey = String(requestBody.eventKey || "").trim();
      const reactionType = String(requestBody.reactionType || "love").trim();
      if (!eventKey) {
        return json(request, 400, { error: "eventKey is required.", ok: false });
      }
      if (!["love"].includes(reactionType)) {
        return json(request, 400, { error: "Unsupported reaction type.", ok: false });
      }
      if (!eventKey.startsWith("prayer-event:") && !eventKey.startsWith("group-prayer:")) {
        return json(request, 400, { error: "Unsupported feed event for reactions.", ok: false });
      }

      const { data: existingReaction, error: reactionLookupError } = await supabase
        .from("prayer_feed_event_reactions")
        .select("id")
        .eq("group_id", group.id)
        .eq("event_key", eventKey)
        .eq("user_id", user.id)
        .eq("reaction_type", reactionType)
        .maybeSingle();

      if (reactionLookupError) {
        throw reactionLookupError;
      }

      if (existingReaction?.id) {
        const { error: deleteError } = await supabase
          .from("prayer_feed_event_reactions")
          .delete()
          .eq("id", existingReaction.id);

        if (deleteError) {
          throw deleteError;
        }
      } else {
        const { error: insertError } = await supabase
          .from("prayer_feed_event_reactions")
          .insert({
            event_key: eventKey,
            group_id: group.id,
            reaction_type: reactionType,
            user_id: user.id,
          });

        if (insertError) {
          throw insertError;
        }
      }

      return json(request, 200, { ok: true });
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

    const { data: readingUploads, error: readingUploadsError } = await supabase
      .from("daily_reading_recordings")
      .select("id, reading_date, created_at, created_by_user_id")
      .eq("group_id", group.id)
      .order("created_at", { ascending: false })
      .limit(40);

    if (readingUploadsError) {
      throw readingUploadsError;
    }

    const { data: groupPrayerNotifications, error: groupPrayerNotificationsError } = await supabase
      .from("notifications")
      .select("id, title, body, notification_type, metadata, created_at, actor_user_id")
      .eq("group_id", group.id)
      .in("notification_type", ["group_prayer_scheduled", "group_prayer_reminder"])
      .order("created_at", { ascending: false })
      .limit(120);

    if (groupPrayerNotificationsError) {
      throw groupPrayerNotificationsError;
    }

    const dedupedGroupPrayerNotifications = Array.from(new Map(
      (groupPrayerNotifications ?? []).map((item: Record<string, unknown>) => {
        const metadata = (item.metadata && typeof item.metadata === "object")
          ? item.metadata as Record<string, unknown>
          : {};
        const source = String(metadata.source || item.notification_type || "group_prayer");
        const scheduledFor = String(metadata.scheduledFor || "");
        const reminderMinutes = String(metadata.reminderMinutes ?? "");
        const key = `${source}:${scheduledFor}:${reminderMinutes}:${String(item.body || "")}`;
        return [key, item];
      }),
    ).values());

    const authorIds = Array.from(new Set([
      ...(intentions ?? []).map((item: Record<string, unknown>) => String(item.created_by_user_id)),
      ...(prayerEvents ?? []).map((item: Record<string, unknown>) => String(item.user_id)),
      ...(readingUploads ?? []).map((item: Record<string, unknown>) => String(item.created_by_user_id)),
      ...dedupedGroupPrayerNotifications
        .map((item: Record<string, unknown>) => String(item.actor_user_id || ""))
        .filter(Boolean),
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

    const intentionIds = (intentions ?? []).map((item: Record<string, unknown>) => String(item.id));
    const reactionsByIntention = new Map<string, { amenCount: number; userHasAmen: boolean }>();
    if (intentionIds.length) {
      const { data: reactions, error: reactionsError } = await supabase
        .from("community_intention_reactions")
        .select("intention_id, user_id, reaction_type")
        .in("intention_id", intentionIds)
        .eq("reaction_type", "love");

      if (reactionsError) {
        throw reactionsError;
      }

      for (const intentionId of intentionIds) {
        reactionsByIntention.set(intentionId, { amenCount: 0, userHasAmen: false });
      }

      for (const reaction of reactions ?? []) {
        const intentionId = String((reaction as Record<string, unknown>).intention_id);
        const bucket = reactionsByIntention.get(intentionId) ?? { amenCount: 0, userHasAmen: false };
        bucket.amenCount += 1;
        if (String((reaction as Record<string, unknown>).user_id) === user.id) {
          bucket.userHasAmen = true;
        }
        reactionsByIntention.set(intentionId, bucket);
      }
    }

    const commentCountByIntention = new Map<string, number>();
    if (intentionIds.length) {
      const { data: comments, error: commentsError } = await supabase
        .from("community_intention_comments")
        .select("intention_id")
        .in("intention_id", intentionIds);

      if (commentsError) {
        throw commentsError;
      }

      for (const intentionId of intentionIds) {
        commentCountByIntention.set(intentionId, 0);
      }

      for (const comment of comments ?? []) {
        const intentionId = String((comment as Record<string, unknown>).intention_id);
        commentCountByIntention.set(intentionId, (commentCountByIntention.get(intentionId) ?? 0) + 1);
      }
    }

    const eventKeys = [
      ...(prayerEvents ?? []).map((item: Record<string, unknown>) => `prayer-event:${String(item.id)}`),
      ...dedupedGroupPrayerNotifications.map((item: Record<string, unknown>) => {
        const metadata = (item.metadata && typeof item.metadata === "object")
          ? item.metadata as Record<string, unknown>
          : {};
        const source = String(metadata.source || item.notification_type || "group_prayer");
        const scheduledFor = String(metadata.scheduledFor || "");
        const reminderMinutes = String(metadata.reminderMinutes ?? "");
        return `group-prayer:${source}:${scheduledFor}:${reminderMinutes}:${String(item.body || "")}`;
      }),
    ];
    const eventReactionsByKey = new Map<string, { amenCount: number; userHasAmen: boolean }>();
    if (eventKeys.length) {
      const { data: eventReactions, error: eventReactionsError } = await supabase
        .from("prayer_feed_event_reactions")
        .select("event_key, user_id, reaction_type")
        .in("event_key", eventKeys)
        .eq("reaction_type", "love");

      if (eventReactionsError) {
        throw eventReactionsError;
      }

      for (const eventKey of eventKeys) {
        eventReactionsByKey.set(eventKey, { amenCount: 0, userHasAmen: false });
      }

      for (const reaction of eventReactions ?? []) {
        const eventKey = String((reaction as Record<string, unknown>).event_key);
        const bucket = eventReactionsByKey.get(eventKey) ?? { amenCount: 0, userHasAmen: false };
        bucket.amenCount += 1;
        if (String((reaction as Record<string, unknown>).user_id) === user.id) {
          bucket.userHasAmen = true;
        }
        eventReactionsByKey.set(eventKey, bucket);
      }
    }

    const feedItems: FeedItem[] = [
      ...(intentions ?? []).map((item: Record<string, unknown>) => {
        const intentionId = String(item.id);
        const reactionState = reactionsByIntention.get(intentionId) ?? { amenCount: 0, userHasAmen: false };
        return {
          amenCount: reactionState.amenCount,
          avatarUrl: profileAvatar(authorsById.get(String(item.created_by_user_id))),
          body: String(item.body || ""),
          commentCount: commentCountByIntention.get(intentionId) ?? 0,
          createdAt: String(item.created_at),
          createdBy: profileName(authorsById.get(String(item.created_by_user_id))),
          id: `intention:${intentionId}`,
          intentionId,
          type: "intention" as const,
          userHasAmen: reactionState.userHasAmen,
        };
      }),
      ...(prayerEvents ?? []).map((item: Record<string, unknown>) => {
        const name = profileName(authorsById.get(String(item.user_id)));
        const eventType = String(item.event_type) === "left" ? "left" : "entered";
        const eventKey = `prayer-event:${String(item.id)}`;
        const reactionState = eventReactionsByKey.get(eventKey) ?? { amenCount: 0, userHasAmen: false };
        return {
          amenCount: reactionState.amenCount,
          avatarUrl: profileAvatar(authorsById.get(String(item.user_id))),
          body: eventType === "left"
            ? `${name} has finished praying`
            : `${name} has entered prayer`,
          createdAt: String(item.created_at),
          createdBy: name,
          eventKey,
          eventType,
          id: `prayer-event:${String(item.id)}`,
          type: "prayer_event" as const,
          userHasAmen: reactionState.userHasAmen,
        };
      }),
      ...(readingUploads ?? []).map((item: Record<string, unknown>) => {
        const name = profileName(authorsById.get(String(item.created_by_user_id)));
        const readingDate = String(item.reading_date || "");
        return {
          avatarUrl: profileAvatar(authorsById.get(String(item.created_by_user_id))),
          body: `${name} uploaded a daily reading for ${readingDate}.`,
          createdAt: String(item.created_at),
          createdBy: name,
          id: `reading-upload:${String(item.id)}`,
          readingDate,
          type: "reading_upload" as const,
        };
      }),
      ...dedupedGroupPrayerNotifications.map((item: Record<string, unknown>) => {
        const metadata = (item.metadata && typeof item.metadata === "object")
          ? item.metadata as Record<string, unknown>
          : {};
        const source = String(metadata.source || item.notification_type || "group_prayer_schedule");
        const scheduledFor = String(metadata.scheduledFor || "");
        const reminderMinutes = String(metadata.reminderMinutes ?? "");
        const eventKey = `group-prayer:${source}:${scheduledFor}:${reminderMinutes}:${String(item.body || "")}`;
        const reactionState = eventReactionsByKey.get(eventKey) ?? { amenCount: 0, userHasAmen: false };
        const actorId = String(item.actor_user_id || "");
        const eventType = source === "group_prayer_start"
          ? "start"
          : source === "group_prayer_reminder"
          ? "reminder"
          : "scheduled";
        const createdBy = actorId ? profileName(authorsById.get(actorId)) : "Prayerbox";
        return {
          amenCount: reactionState.amenCount,
          avatarUrl: actorId ? profileAvatar(authorsById.get(actorId)) : null,
          body: String(item.body || item.title || "Group prayer update"),
          createdAt: String(item.created_at),
          createdBy,
          eventKey,
          eventType,
          id: `group-prayer-event:${String(item.id)}`,
          type: "group_prayer_event" as const,
          userHasAmen: reactionState.userHasAmen,
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
