const CACHE_NAME = 'agroai-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js',
  'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js'
];

// Installation : on met en cache la coquille de l'app (HTML + libs CDN)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            // Une ressource CDN indisponible ne doit pas bloquer toute l'installation
            console.warn('SW: échec de mise en cache de', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Stratégie : Cache d'abord pour la coquille, réseau d'abord pour les appels API (données fraîches)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Ne jamais mettre en cache les appels API (histoire, chat, clés...) : ils doivent rester dynamiques
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(JSON.stringify({ error: 'Hors connexion : action impossible sans réseau.' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 503
        })
      )
    );
    return;
  }

  // Pour le reste (app shell, libs CDN) : cache d'abord, sinon réseau, avec mise à jour silencieuse du cache
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req).then((res) => {
        if (res && res.ok) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return res;
      }).catch(() => cached);

      return cached || networkFetch;
    })
  );
});
