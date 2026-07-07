/* WebTracker app shell cache for offline use. */
'use strict';

const CACHE_NAME = 'webtracker-v8';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/med.js',
  './js/mod.js',
  './js/xm.js',
  './js/patternview.js',
  './js/player.js',
  './js/pwa.js',
  './js/worklet.js',
  './manifest.webmanifest',
  './favicon.ico',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/screenshots/webtracker.png',
  './assets/social-preview.png'
];

const appUrl = path => new URL(path, self.location).href;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL.map(appUrl)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => key === CACHE_NAME ? null : caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(appUrl('./index.html'), copy));
          return response;
        })
        .catch(() => caches.match(appUrl('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      }))
  );
});
