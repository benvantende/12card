/*
 * sw.js — service worker: makes the app installable and lets it start without a network.
 *
 * Only the app's own files are cached. Card files never go through here: the app reads
 * them straight from disk.
 *
 * VERSION must match the ?v= in index.html (tests/pwa_test.py checks this).
 * A new VERSION = a new cache; the app then offers "Update".
 */
const VERSION = '1.0.0';
const CACHE = 'tmm-' + VERSION;
const V = '?v=' + VERSION;
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './config/card-model12.js' + V, './config/mixer.js' + V, './config/mastering.js' + V, './loudness.js' + V,
  './style.css' + V, './icons.js' + V, './model12.js' + V, './fx.js' + V, './master.js' + V, './trackmap.js' + V, './player.js' + V, './cardio.js' + V, './cover.js' + V, './flac.js' + V, './app.js' + V,
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png', './icons/cover.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  // no skipWaiting here: an update waits until the user clicks "Update" (never in the middle of a card write)
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('tmm-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // the page: network first, so a new version shows up; cached copy when offline
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put('./index.html', res.clone());
        return res;
      } catch (err) {
        return (await caches.match('./index.html', { cacheName: CACHE })) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // scripts, styles, icons: versioned, so cache first
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  })());
});
