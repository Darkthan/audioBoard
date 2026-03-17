'use strict';
const CACHE   = 'audioboard-v1';
const PRECACHE = ['/css/style.css', '/js/p2p-audio.js', '/offline.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(PRECACHE.map(u => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { pathname } = new URL(e.request.url);
  // Ne pas intercepter: API, stream, upload, auth, websocket
  if (['/stream/','/download/','/api/','/upload','/login','/logout','/p2p','/covers/']
      .some(p => pathname.startsWith(p))) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && (e.request.destination === 'style' || e.request.destination === 'script')) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request)
          .then(cached => cached || caches.match('/offline.html'))
      )
  );
});
