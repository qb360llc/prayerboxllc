const config = window.PRAYERBOX_PORTAL_CONFIG || {};
const projectUrl = config.projectUrl || "";
const anonKey = config.anonKey || "";
const vapidPublicKey = config.vapidPublicKey || "";

let registrationPromise = null;
let installPromptEvent = null;

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function getRegistration() {
  if (!("serviceWorker" in navigator)) {
    return null;
  }

  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker.register("./sw.js");
  }

  return registrationPromise;
}

async function getPushState() {
  const registration = await getRegistration();
  const subscription = registration && "pushManager" in registration
    ? await registration.pushManager.getSubscription()
    : null;

  return {
    canInstall: Boolean(installPromptEvent),
    isInstalled: window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true,
    permission: "Notification" in window ? Notification.permission : "unsupported",
    subscribed: Boolean(subscription),
    supported: Boolean(window.isSecureContext && registration && "PushManager" in window && "Notification" in window),
  };
}

async function subscribeToPush({ getAccessToken }) {
  if (!vapidPublicKey) {
    throw new Error("VAPID public key is missing from portal config.");
  }

  const registration = await getRegistration();
  if (!registration || !("pushManager" in registration)) {
    throw new Error("Push notifications are not supported in this browser.");
  }

  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      userVisibleOnly: true,
    });
  }

  const accessToken = await getAccessToken();
  const response = await fetch(`${projectUrl}/functions/v1/push-subscriptions`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "subscribe",
      subscription: subscription.toJSON(),
      userAgent: navigator.userAgent,
    }),
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "Failed to save push subscription.");
  }

  return subscription;
}

async function unsubscribeFromPush({ getAccessToken }) {
  const registration = await getRegistration();
  if (!registration || !("pushManager" in registration)) {
    return;
  }

  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    return;
  }

  const accessToken = await getAccessToken();
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();

  const response = await fetch(`${projectUrl}/functions/v1/push-subscriptions`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "unsubscribe",
      endpoint,
    }),
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "Failed to remove push subscription.");
  }
}

async function installApp() {
  if (!installPromptEvent) {
    throw new Error("Install prompt is not available on this device right now.");
  }
  await installPromptEvent.prompt();
  await installPromptEvent.userChoice;
  installPromptEvent = null;
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPromptEvent = event;
});

window.PRayerboxPWA = {
  getPushState,
  getRegistration,
  installApp,
  subscribeToPush,
  unsubscribeFromPush,
};

getRegistration().catch(() => {});
