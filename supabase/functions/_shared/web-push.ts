import webpush from "npm:web-push@3.6.7";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

type PushPayload = {
  body: string;
  data?: Record<string, unknown>;
  tag?: string;
  title: string;
};

type PushRow = {
  auth_key: string;
  endpoint: string;
  id: string;
  p256dh_key: string;
};

function getConfig() {
  const publicKey = Deno.env.get("WEB_PUSH_VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("WEB_PUSH_VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("WEB_PUSH_SUBJECT") || "mailto:admin@prayerbox.local";

  if (!publicKey || !privateKey) {
    return null;
  }

  return { privateKey, publicKey, subject };
}

async function loadSubscriptions(
  supabase: SupabaseClient,
  recipientUserIds: string[],
) {
  if (!recipientUserIds.length) {
    return [];
  }

  const { data, error } = await supabase
    .from("web_push_subscriptions")
    .select("id, endpoint, p256dh_key, auth_key")
    .in("user_id", recipientUserIds);

  if (error) throw error;
  return (data ?? []) as PushRow[];
}

async function removeSubscription(supabase: SupabaseClient, subscriptionId: string) {
  const { error } = await supabase
    .from("web_push_subscriptions")
    .delete()
    .eq("id", subscriptionId);

  if (error) throw error;
}

export async function sendPushToUsers(
  supabase: SupabaseClient,
  recipientUserIds: string[],
  payload: PushPayload,
) {
  const config = getConfig();
  if (!config || !recipientUserIds.length) {
    return;
  }

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  const subscriptions = await loadSubscriptions(supabase, recipientUserIds);

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              auth: subscription.auth_key,
              p256dh: subscription.p256dh_key,
            },
          },
          JSON.stringify(payload),
        );
      } catch (error) {
        const statusCode = typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : 0;

        if (statusCode === 404 || statusCode === 410) {
          await removeSubscription(supabase, subscription.id);
          return;
        }

        console.error("Web push failed", subscription.id, error);
      }
    }),
  );
}
