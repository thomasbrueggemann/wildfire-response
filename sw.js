/* Wildfire Response — offline service worker.
 *
 * Everything the game needs is code and generated at runtime, so the whole
 * app precaches in one shot and then runs entirely offline. Bump CACHE_VERSION
 * whenever a shipped file changes.
 */

const CACHE_VERSION = 'wildfire-v2';

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',

  './src/main.js',
  './src/game.js',
  './src/config.js',
  './src/utils.js',
  './src/geometry.js',
  './src/textures.js',
  './src/terrain.js',
  './src/props.js',
  './src/fire.js',
  './src/water.js',
  './src/particles.js',
  './src/trucks.js',
  './src/vehicle.js',
  './src/cameras.js',
  './src/minimap.js',
  './src/audio.js',
  './src/input.js',
  './src/hud.js',

  './vendor/three.module.min.js',
  './vendor/three.core.min.js',

  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // addAll is atomic — one bad URL would throw away the whole install, so
    // fetch individually and let the rest through.
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] precache miss:', url, err);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the shell from cache so a cold offline start works.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Everything else: cache first, then network, refreshing the cache quietly.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.status === 200 && fresh.type === 'basic') {
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});

// Lets the page trigger an immediate update after a new version installs.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
