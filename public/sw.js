/**
 * レジ画面のオフライン対応（Service Worker）
 *
 * - レジ画面（/admin）と料金計算（/pricing.js）だけをキャッシュする。
 *   ダッシュボード・管理画面・会計一覧・API には手を出さない（そのまま通信する）。
 * - ネットワーク優先：つながれば最新を表示してキャッシュも更新、つながらない（または遅い）ときだけキャッシュを使う。
 * - アプリを更新したら VERSION を変える。新しい版が入ると古いキャッシュは消える。
 */
const VERSION = '2026-11-01-3';
const CACHE = 'mogiten-register-' + VERSION;
const FONT_CACHE = 'mogiten-fonts-v1';      // Web フォント（版をまたいで使い回す）
const SHELL = ['/admin', '/pricing.js'];
const NETWORK_TIMEOUT = 4000;               // これ以上待ったらキャッシュを表示（テザリングが不安定なとき用）

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' で HTTP キャッシュを通さず最新を取る
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload', credentials: 'same-origin' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('mogiten-') && key !== CACHE && key !== FONT_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source && event.source.postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      event.respondWith(networkFirst(req, '/admin'));
    } else if (url.pathname === '/pricing.js') {
      event.respondWith(networkFirst(req, '/pricing.js'));
    }
    return;   // それ以外（ダッシュボード・API など）は何もしない
  }

  // Google Fonts：一度取れたらキャッシュから（取れなければ端末のフォントで表示される）
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then(async (res) => {
    if (res.ok && !res.redirected) await cache.put(key, res.clone());
    return res;
  });
  try {
    return await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT)),
    ]);
  } catch (e) {
    const cached = await cache.match(key);
    if (cached) {
      network.catch(() => {});   // 裏で届いたらキャッシュだけ更新しておく
      return cached;
    }
    return network;   // キャッシュもなければ通信の結果（エラー）をそのまま返す
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') await cache.put(req, res.clone());
    return res;
  } catch (e) {
    return new Response('', { status: 504 });
  }
}
