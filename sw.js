'use strict';
/* =========================================================
   SERVICE WORKER — cache del app shell para uso offline.
   Sube CACHE_NAME al publicar cambios para invalidar cachés viejas.
   ========================================================= */
const CACHE_NAME = 'ciphercube-v18';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './css/base.css',
  './css/theme.css',
  './css/components.css',
  './css/animations.css',
  './css/admin.css',
  './js/app.js',
  './js/api.js',
  './js/auth.js',
  './js/admin.js',
  './js/ui.js',
  './js/camera.js',
  './js/camera-live.js',
  './js/cube3d.js',
  './js/colorcluster.js',
  './js/crypto.js',
  './js/plans.js',
  './js/storage.js',
  './js/argon2-loader.js',
  './assets/logo-black.png',
  './assets/logo-white.png',
  './vendor/argon2-bundled.min.js',
  './vendor/argon2.wasm',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: estando en línea siempre se sirve la versión más reciente
// (evita que quede atascado código viejo); la caché es solo respaldo offline.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).then(response => {
      if (response && response.ok){
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
