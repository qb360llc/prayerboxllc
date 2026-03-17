import { createClient } from "jsr:@supabase/supabase-js@2";

type PushSubscriptionBody = {
  action?: "subscribe" | "unsubscribe";
  endpoint?: string;
  subscription?: {
    endpoint?: string;
    keys?: {
      auth?: string;
      p256dh?: string;
    };
  };
  userAgent?: string;
};

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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  try {
    const supabase = await getSupabase();
    const user = await getAuthedUser(request, supabase);

    if (request.method !== "POST") {
      return json(request, 405, { error: "Method not allowed.", ok: false });
    }

    const body = await request.json() as PushSubscriptionBody;
    const action = body.action || "subscribe";

    if (action === "unsubscribe") {
      const endpoint = body.endpoint?.trim();
      if (!endpoint) {
        return json(request, 400, { error: "endpoint is required.", ok: false });
      }

      const { error } = await supabase
        .from("web_push_subscriptions")
        .delete()
        .eq("user_id", user.id)
        .eq("endpoint", endpoint);

      if (error) throw error;
      return json(request, 200, { ok: true });
    }

    const endpoint = body.subscription?.endpoint?.trim();
    const p256dh = body.subscription?.keys?.p256dh?.trim();
    const auth = body.subscription?.keys?.auth?.trim();
    if (!endpoint || !p256dh || !auth) {
      return json(request, 400, { error: "Valid subscription payload is required.", ok: false });
    }

    const { error } = await supabase
      .from("web_push_subscriptions")
      .upsert({
        auth_key: auth,
        endpoint,
        p256dh_key: p256dh,
        updated_at: new Date().toISOString(),
        user_agent: body.userAgent?.slice(0, 500) || null,
        user_id: user.id,
      }, {
        onConflict: "endpoint",
      });

    if (error) throw error;

    return json(request, 200, { ok: true });
  } catch (error) {
    return json(request, 400, {
      error: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    });
  }
});
