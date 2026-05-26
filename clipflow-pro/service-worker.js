const CACHE_VERSION = 'clipflow-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/css/components.css',
  '/css/animations.css',
  '/js/app.js',
  '/js/storage/db.js',
  '/js/storage/authStore.js',
  '/js/storage/videoStore.js',
  '/js/core/audioAnalyzer.js',
  '/js/core/sceneDetector.js',
  '/js/core/videoProcessor.js',
  '/js/core/clipGenerator.js',
  '/js/platforms/oauthHelper.js',
  '/js/platforms/tiktok.js',
  '/js/platforms/instagram.js',
  '/js/platforms/youtube.js',
  '/js/scheduler/jobQueue.js',
  '/js/scheduler/retryHandler.js',
  '/js/scheduler/cronEngine.js',
  '/js/ui/notifications.js',
  '/js/ui/dashboard.js',
  '/js/ui/upload.js',
  '/js/ui/clips.js',
  '/js/ui/queue.js',
  '/auth/callback.html',
  '/manifest.json',
];

const COOP_COEP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  const isLocal = url.origin === self.location.origin;
  const isNavigate = request.mode === 'navigate';
  const isStaticAsset = isLocal && STATIC_ASSETS.some(a => url.pathname === a || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html') || url.pathname.endsWith('.json'));
  const isFFmpegAsset = url.hostname.includes('unpkg.com') || url.hostname.includes('cdn.jsdelivr.net');

  if (isFFmpegAsset) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return addHeaders(cached, request.url.endsWith('.wasm') ? { ...COOP_COEP_HEADERS, 'Content-Type': 'application/wasm' } : COOP_COEP_HEADERS);
        const fetched = await fetch(request);
        cache.put(request, fetched.clone());
        return addHeaders(fetched, COOP_COEP_HEADERS);
      })
    );
    return;
  }

  if (isNavigate || (isLocal && (isStaticAsset || url.pathname === '/'))) {
    event.respondWith(
      caches.match(request).then(async (cached) => {
        const fresh = fetch(request).then((res) => {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, clone));
          return addHeaders(res, COOP_COEP_HEADERS);
        }).catch(() => cached);
        return addHeaders(cached, COOP_COEP_HEADERS) || fresh;
      })
    );
    return;
  }

  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

function addHeaders(response, headers) {
  if (!response) return response;
  const newHeaders = new Headers(response.headers);
  for (const [key, val] of Object.entries(headers)) {
    newHeaders.set(key, val);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
