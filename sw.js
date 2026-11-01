// Garde l'app disponible hors ligne. La météo n'est pas mise en cache ici : l'app garde ses derniers relevés.
const CACHE = "jardin-v1";
const SHELL = ["./", "index.html", "app.js", "engine.js", "plants.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
      return res;
    })));
    return;
  }

  if (url.origin !== location.origin) return;
  // Réseau d'abord pour recevoir les mises à jour, cache si le téléphone est hors ligne.
  event.respondWith(fetch(request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
    return res;
  }).catch(() => caches.match(request).then((hit) => hit || caches.match("index.html"))));
});
