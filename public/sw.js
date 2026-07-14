/* Inspection Hub — Service Worker (no offline caching, install-only) */
'use strict';

// Intentionally does not cache any assets or data.
// Its only purpose is to satisfy PWA installability requirements
// so the app can be added to the home screen in standalone mode.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});
