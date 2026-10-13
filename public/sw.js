/* Service Worker: App-Shell-Cache.
   Zweck ist das native Gefuehl beim Aufwachen: Ohne Cache zeigt die PWA nach
   dem Standby eine weisse Seite, solange das Netz noch nicht wieder steht.
   Strategie:
   - Shell (HTML/CSS/JS/Fonts/Icons): network-first mit Cache-Fallback. So ist
     ein Deployment sofort sichtbar, ohne dass der Nutzer nachladen muss, und
     offline kommt trotzdem die letzte bekannte Version.
   - API und WebSocket: nie cachen. Bestelldaten muessen frisch sein, eine
     veraltete Bestellliste an der Theke waere schlimmer als ein Fehler.
*/

const CACHE = 'thekenflow-shell-v1';

// Beim Install nur die Huelle vorladen. /version.js bewusst nicht, damit die
// Versionsanzeige nie aus dem Cache kommt.
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/sw-register.js',
  '/tf_logo.png',
  '/manifest.webmanifest',
  '/fonts/material-symbols.css',
  '/fonts/MaterialSymbolsOutlined.woff2',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Einzeln adden: eine fehlende Datei soll nicht die ganze Installation kippen
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Pfade, die immer ans Netz gehen muessen
function isLiveData(url) {
  return url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/ws')
    || url.pathname === '/health'
    || url.pathname === '/version.js';
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isLiveData(url)) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // Nur verwertbare Antworten in den Cache legen
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // Navigationsanfrage ohne Netz: die Shell ausliefern
        if (req.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      })
  );
});
