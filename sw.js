// Service worker: faster repeat visits and an offline-capable patent search.
// - Page, scripts, styles: network first (a new deploy shows up immediately when online),
//   falling back to the cached copy when offline.
// - data/patents.json (the 2,799-patent corpus, the largest file): served from cache at once
//   and refreshed in the background (stale-while-revalidate).
// - Everything cross-origin (the AI backend, pdf.js on cdnjs) is never intercepted.
const CACHE = "researchgap-v1";
const CORE = ["./", "index.html", "styles.css", "script.js", "query-match.js", "logo.png", "data/patents.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await cache.match("index.html");
      if (shell) return shell;
    }
    throw err;
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const refresh = fetch(event.request)
    .then((response) => {
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    })
    .catch(() => cached);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return refresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/data/patents.json")) {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }
  event.respondWith(networkFirst(request));
});
