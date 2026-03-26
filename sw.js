const CACHE_VERSION = 'v3';
const TILE_CACHE = 'map-tiles-' + CACHE_VERSION;
const STATIC_CACHE = 'static-' + CACHE_VERSION;

// キャッシュするタイルのオリジン
const TILE_ORIGINS = [
  'tile.openstreetmap.org',
  'cyberjapandata.gsi.go.jp',
];

// キャッシュするスタティックリソース（起動時にプリキャッシュ）
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/sw.js',
  'https://unpkg.com/maplibre-gl@4.1.3/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.1.3/dist/maplibre-gl.css',
];

// タイルキャッシュの上限（枚数）
const TILE_CACHE_LIMIT = 200;

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== TILE_CACHE && k !== STATIC_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // タイルキャッシュ（Cache First）
  if (TILE_ORIGINS.some(o => url.hostname.includes(o))) {
    e.respondWith(tileFirst(e.request));
    return;
  }

  // スタティックリソース（Cache First）
  if (e.request.method === 'GET' && (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/style.css' ||
    url.hostname === 'unpkg.com'
  )) {
    e.respondWith(staticFirst(e.request));
    return;
  }

  // APIリクエストはキャッシュしない（Network Only）
});

async function tileFirst(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const res = await fetch(request);
    if (res.ok) {
      // キャッシュ上限チェック（非同期で間引き）
      cache.put(request, res.clone());
      trimTileCache(cache);
    }
    return res;
  } catch {
    return new Response('', { status: 503 });
  }
}

async function staticFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return cached || new Response('', { status: 503 });
  }
}

// タイルキャッシュが上限を超えたら古いものを削除
async function trimTileCache(cache) {
  const keys = await cache.keys();
  if (keys.length > TILE_CACHE_LIMIT) {
    // 古い順に超過分を削除
    const toDelete = keys.slice(0, keys.length - TILE_CACHE_LIMIT);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}
