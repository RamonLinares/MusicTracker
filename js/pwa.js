/* pwa.js - install/offline support. */
'use strict';

(() => {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(window.location.protocol)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .catch(err => console.warn('Service worker registration failed:', err));
  });
})();
