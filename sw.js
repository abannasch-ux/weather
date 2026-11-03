// Andy's Weather service worker — caches the app shell so it opens offline.
// Weather, radar and alert data always come fresh from the network.

var CACHE = 'andy-weather-v5.1';
var SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // APIs + Leaflet CDN + map tiles: network only
  // App code (page + scripts): network-first so updates show up on the
  // next open instead of lagging a launch behind; cache is the offline fallback.
  if (event.request.mode === 'navigate' || /\.(html|js)$/.test(url.pathname)) {
    event.respondWith(
      fetch(event.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(event.request, copy); });
        return res;
      }).catch(function () {
        return caches.match(event.request, { ignoreSearch: true });
      })
    );
    return;
  }
  // Icons / manifest: cache-first.
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(event.request);
    })
  );
});
