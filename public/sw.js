'use strict';

// Incrémenter CACHE_STATIC quand CSS/JS changent pour forcer le remplacement
const CACHE_STATIC = 'ab-static-v2';
const CACHE_PAGES  = 'ab-pages-v1';   // pages HTML visitées
const CACHE_AUDIO  = 'ab-audio-v1';   // flux audio lus
const CACHE_ASSETS = 'ab-assets-v1';  // covers + waveforms API

const ALL_CACHES = [CACHE_STATIC, CACHE_PAGES, CACHE_AUDIO, CACHE_ASSETS];

const PRECACHE = ['/css/style.css', '/js/p2p-audio.js', '/offline.html'];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then(c => Promise.allSettled(PRECACHE.map(u => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !ALL_CACHES.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return; // Ne jamais cacher les POST/PUT/DELETE

  const { pathname } = new URL(req.url);

  // Laisser passer : auth, upload, téléchargement, WebSocket P2P
  if (['/login', '/logout', '/setup', '/upload', '/download/', '/p2p']
      .some(p => pathname.startsWith(p))) return;

  // ── Flux audio : cache-first + gestion des range requests ──────────────────
  if (pathname.startsWith('/stream/')) {
    e.respondWith(handleAudio(req));
    return;
  }

  // ── Assets statiques (CSS/JS) : cache-first ────────────────────────────────
  if (pathname.startsWith('/css/') || pathname.startsWith('/js/')) {
    e.respondWith(cacheFirst(req, CACHE_STATIC));
    return;
  }

  // ── Covers : cache-first ───────────────────────────────────────────────────
  if (pathname.startsWith('/covers/')) {
    e.respondWith(cacheFirst(req, CACHE_ASSETS));
    return;
  }

  // ── API waveform : stale-while-revalidate ──────────────────────────────────
  if (pathname.startsWith('/api/waveform/')) {
    e.respondWith(staleWhileRevalidate(req, CACHE_ASSETS));
    return;
  }

  // ── Pages HTML (navigate) : network-first avec fallback cache ──────────────
  if (req.mode === 'navigate') {
    e.respondWith(networkFirstPage(req));
    return;
  }
});

// ── Stratégies ────────────────────────────────────────────────────────────────

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) caches.open(cacheName).then(c => c.put(req, res.clone()));
    return res;
  } catch {
    return new Response('Ressource non disponible hors ligne', { status: 503 });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fresh  = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || fresh;
}

async function networkFirstPage(req) {
  try {
    const res = await fetch(req);
    if (res.ok) caches.open(CACHE_PAGES).then(c => c.put(req, res.clone()));
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    const offline = await caches.match('/offline.html');
    return offline || new Response('Hors ligne', { status: 503 });
  }
}

// ── Audio : cache-first + reconstruction des range requests ──────────────────
async function handleAudio(req) {
  const cache = await caches.open(CACHE_AUDIO);

  // Chercher la réponse complète en cache (clé sans Range header)
  const cached = await cache.match(req.url);
  if (cached) {
    const range = req.headers.get('range');
    return range ? serveRange(cached, range) : cached;
  }

  // Pas en cache : récupérer le fichier complet (sans Range) pour le cacher
  try {
    const fullReq = new Request(req.url, { headers: { Accept: req.headers.get('Accept') || '*/*' } });
    const res = await fetch(fullReq);
    if (res.ok && res.status === 200) {
      cache.put(req.url, res.clone());
      const range = req.headers.get('range');
      return range ? serveRange(res, range) : res;
    }
    return res;
  } catch {
    return new Response('Audio non disponible hors ligne', {
      status: 503, headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// Découpe une réponse complète en réponse 206 Partial Content
async function serveRange(response, rangeHeader) {
  const blob  = await response.clone().blob();
  const size  = blob.size;
  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!match) return response.clone();

  const start = parseInt(match[1], 10);
  const end   = match[2] ? parseInt(match[2], 10) : size - 1;
  const chunk = blob.slice(start, end + 1, blob.type || 'audio/mpeg');

  return new Response(chunk, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Range':  `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Content-Type':   blob.type || 'audio/mpeg',
      'Accept-Ranges':  'bytes',
    },
  });
}
