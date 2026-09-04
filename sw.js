/* service worker — 离线缓存应用外壳 */
const CACHE = 'vocab-pwa-v7';
const SHELL = [
  './',
  './index.html',
  './core.js',
  './manifest.json',
  './icon.svg',
  './libs/xlsx.full.min.js',
  './zhongkao1600.xlsx',
  './mespeak/voices/zh.json'
];

self.addEventListener('install', function (e) {
  // 逐文件缓存，单个失败（如离线首装拿不到 xlsx）不阻断整体安装
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function (err) { console.warn('cache skip:', u, err); }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then(function (cached) {
      const net = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});
