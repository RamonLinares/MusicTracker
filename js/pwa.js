/* pwa.js - install/offline support. */
'use strict';

(() => {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(window.location.protocol)) return;

  // skip the app-shell cache during local development — it serves stale code
  // after every edit; production (GitHub Pages) still installs normally
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()))
      .catch(() => {});
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .catch(err => console.warn('Service worker registration failed:', err));
  });
})();
