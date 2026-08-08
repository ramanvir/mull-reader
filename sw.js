// Mull Reader service worker — cache-first app shell for full offline use.

const CACHE = 'mull-v26';

const ASSETS = [
  './',
  './index.html',
  './about.html',
  './privacy.html',
  './terms.html',
  './styles.css',
  './manifest.json',
  './js/app.js',
  './js/fs.js',
  './js/prefs.js',
  './js/render.js',
  './vendor/marked.min.js',
  './vendor/purify.min.js',
  './vendor/highlight.min.js',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './favicon.ico',
];

// The host 308s the .html URLs to their extensionless forms, so fetching
// './about.html' yields a response with the redirected flag set. Browsers
// refuse to accept a redirected response for a navigation request, so a
// cached one bricks the very link it was saved for. Rewrapping the body in
// a fresh Response clears the flag.
async function stripRedirect(response) {
  if (!response.redirected) return response;
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (u) => {
      // 'no-cache' revalidates against the server so a new SW version never
      // fills its cache with stale copies from the HTTP cache.
      const response = await fetch(u, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`precache failed: ${u} (${response.status})`);
      await cache.put(u, await stripRedirect(response));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // The canonical URLs are extensionless; the precache stores the .html
    // files, so /about, /privacy, and /terms hit the cache too.
    if (request.mode === 'navigate' && !url.pathname.endsWith('/') && !url.pathname.endsWith('.html')) {
      const aliased = await caches.match(`${url.pathname}.html`);
      if (aliased) return aliased;
    }
    try {
      const response = await fetch(request);
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(async (cache) => cache.put(request, await stripRedirect(copy)));
      }
      return response;
    } catch (err) {
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
