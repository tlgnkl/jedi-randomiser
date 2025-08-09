'use strict';
const CACHE_NAME = 'jedi-praktiki-v4-20250808-2';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=2025-08-08-2',
  './app.js',
  './firstthreepract.md',
  './manifest.webmanifest',
  './favicon.ico',
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => k !== CACHE_NAME && caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // pass-through others
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') return caches.match('./index.html');
    throw err;
  }
}
