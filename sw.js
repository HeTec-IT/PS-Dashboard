// Pencil Selling – o2 – Service Worker
// Beim Update NUR diese Versionsnummer hochzählen -> alte Caches werden entfernt.
const CACHE = "pencil-o2-v6";
const SHELL = ["./", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first mit Cache-Fallback: online immer die neueste Version, offline die letzte bekannte.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    // Seiten (HTML) immer beim Server nachfragen -> Update kommt sofort an,
    // nicht erst nach Ablauf des GitHub-Pages-Caches (10 Min.).
    (e.request.mode === "navigate" || e.request.destination === "document"
      ? fetch(e.request.url, { cache: "no-cache" })
      : fetch(e.request))
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./")))
  );
});
