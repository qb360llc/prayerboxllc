const CACHE_NAME = "prayerbox-shell-v4";
const APP_SHELL = [
  "/",
  "/home.html",
  "/members.html",
  "/notifications.html",
  "/settings.html",
  "/admin.html",
  "/setup.html",
  "/config.js",
  "/site.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/"))),
  );
});

self.addEventListener("push", (event) => {
  let payload = {
    body: "Open Prayerbox to view the latest update.",
    data: { url: "/home.html" },
    title: "Prayerbox",
  };

  try {
    payload = { ...payload, ...(event.data ? event.data.json() : {}) };
  } catch {
    // Ignore invalid push payloads and fall back to defaults.
  }

  const options = {
    badge: "/icon.svg",
    body: payload.body,
    data: payload.data || { url: "/home.html" },
    icon: "/icon.svg",
  };

  if (payload.tag) {
    options.tag = payload.tag;
  }

  event.waitUntil(self.registration.showNotification(payload.title || "Prayerbox", options));
});

function isHomePath(pathname) {
  return pathname === "/" || pathname === "/home.html";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/home.html", self.location.origin);

  event.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: "window" }).then(async (clients) => {
      const matchingClient = clients.find((client) => "focus" in client && client.url === targetUrl.href);
      if (matchingClient) {
        return matchingClient.focus();
      }

      if (isHomePath(targetUrl.pathname)) {
        const homeClient = clients.find((client) => {
          if (!("focus" in client) || !("navigate" in client)) return false;
          try {
            const clientUrl = new URL(client.url);
            return clientUrl.origin === self.location.origin && isHomePath(clientUrl.pathname);
          } catch {
            return false;
          }
        });

        if (homeClient) {
          await homeClient.navigate(targetUrl.href);
          return homeClient.focus();
        }
      }

      return self.clients.openWindow(targetUrl.href);
    }),
  );
});
