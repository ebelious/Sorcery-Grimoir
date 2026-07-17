self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(['./', './index.html', './manifest.json']))
      .catch(() => {}) // don't block install if one of these can't be fetched yet
  );
  self.skipWaiting();
});

// Controls whether images/data get opportunistically cached as they're
// viewed (the "cache by default" behavior, toggleable in Settings ->
// Offline Access). Defaults on. The page tells us the current setting via
// postMessage on load and whenever it changes, since a service worker can't
// read the page's own settings/localStorage directly. This does NOT affect
// the manual "Cache Card Data"/"Cache App Data" buttons, which are explicit
// user actions independent of this default.
let autoCacheEnabled = true;
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'set-auto-cache') {
    autoCacheEnabled = !!event.data.enabled;
  }
});

self.addEventListener('activate', (event) => {
  console.log('Service worker active');
  event.waitUntil(self.clients.claim());
});

// Caches the app shell (the page itself) so it still loads with no network
// connection at all, not just the card images. Network-first: always try to
// get the freshest version when online (and update the cache with it), only
// falling back to the cached copy when the network request fails.
const APP_SHELL_CACHE = 'sg-app-shell-v1';

// Caches card art (and similar static images) the first time they're
// viewed, so they're available offline afterward without the user doing
// anything. Cache-first: serve from cache if we have it, otherwise fetch
// from network and store a copy for next time. Only applies to the card
// image CDN -- everything else passes through untouched.
const IMG_CACHE = 'sg-card-images-v1';
const IMG_HOST_RE = /images\.sorcerycard\.io|storage\.googleapis\.com\/cardeio-images|elaborate-mooncake-835943\.netlify\.app\/backgrounds\//;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = req.url;

  if (req.method !== 'GET') return;

  // App shell: the page navigation itself, or a direct request for
  // index.html/manifest.json.
  if (req.mode === 'navigate' || url.endsWith('/index.html') || url.endsWith('/manifest.json')) {
    event.respondWith(
      fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            caches.open(APP_SHELL_CACHE).then((cache) => cache.put(req, networkResponse.clone()));
          }
          return networkResponse;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match('./index.html') || caches.match('./'))
        )
    );
    return;
  }

  // Card images: cache-first.
  if (IMG_HOST_RE.test(url)) {
    event.respondWith(
      caches.open(IMG_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req)
            .then((networkResponse) => {
              if (autoCacheEnabled && networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
                return cache.put(req, networkResponse.clone()).then(() => networkResponse);
              }
              return networkResponse;
            })
            .catch(() => cached); // offline and never cached -- nothing we can do, request just fails
        })
      )
    );
    return;
  }
  // everything else passes through normally
});

// Caches the core JSON data files the app actually runs on. CARDS,
// FAQ_DATA, and CODEX_DATA all start as empty arrays in index.html and are
// populated entirely by fetching these at startup -- without caching them
// too, the app shell would load offline but show no cards at all. Same
// network-first strategy as the app shell: freshest data when online,
// last-known-good data when offline.
const DATA_CACHE = 'sg-data-v1';
const DATA_FILE_RE = /\/(cards|codex|news|discord|events|rewards)\.json(\?|$)/;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method === 'GET' && DATA_FILE_RE.test(req.url)) {
    event.respondWith(
      fetch(req)
        .then((networkResponse) => {
          if (autoCacheEnabled && networkResponse && networkResponse.ok) {
            caches.open(DATA_CACHE).then((cache) => cache.put(req.url.split('?')[0], networkResponse.clone()));
          }
          return networkResponse;
        })
        .catch(() => caches.match(req.url.split('?')[0]))
    );
  }
});
// in-app "Notifications" toggle -- timer alerts, new-content alerts). Only
// acts when a `section` was tagged on the notification's data (news/discord/
// yt); Firebase push notifications (the separate News/Discord/YouTube push
// topics) don't set that field, so this intentionally leaves those alone.
self.addEventListener('notificationclick', (event) => {
  var section = event.notification.data && event.notification.data.section;
  event.notification.close();
  if (!section) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'notification-click', section: section });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./?open=' + section);
      }
    })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE CLOUD MESSAGING (background push)
// This handles News/Discord/YouTube notifications that arrive while the app
// is closed or backgrounded. Fill in the SAME config used in index.html
// (Project Settings → General → Your apps → Web app).
// ─────────────────────────────────────────────────────────────────────────────
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAnTZ_8Ya-l9lWEG2CIw6OAR0X8dvQziys",
  authDomain: "sorcery-grimoir.firebaseapp.com",
  projectId: "sorcery-grimoir",
  storageBucket: "sorcery-grimoir.firebasestorage.app",
  messagingSenderId: "58533506214",
  appId: "1:58533506214:web:ce8917b858d9da0e211867",
  measurementId: "G-34SMF7DB6S"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  var n = (payload && payload.notification) || {};
  var title = n.title || 'Sorcery Grimoire';
  var options = {
    body: n.body || '',
    icon: 'icons/icon-192.png'
  };
  self.registration.showNotification(title, options);
});
