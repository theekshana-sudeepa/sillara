/**
 * Minimal offline shell. The real offline capability lives in IndexedDB
 * (catalog cache + sales outbox in src/lib/db.ts) — this worker only keeps
 * the app shell loadable with zero network. Swap for vite-plugin-pwa with
 * Workbox when asset hashing needs proper precache manifests.
 */
const SHELL = 'sillara-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.url.includes('/api/')) return;
  // Public receipt pages must always hit the network first — a customer
  // opening a shared link should never be served another shop's cached shell.
  const path = new URL(request.url).pathname;
  if (path.startsWith('/r/') || path.startsWith('/supplier')) return;
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match('/'))),
  );
});
