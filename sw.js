const CACHE = "spotify-lite-v76";
const FILES = ["/", "/styles.css", "/app.js", "/manifest.webmanifest", "/assets/spotify-lite-64.png", "/assets/spotify-lite-192.png", "/assets/spotify-lite-256.png", "/assets/spotify-lite-512.png"];

self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES))));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((response) => response || caches.match("/"))));
});
