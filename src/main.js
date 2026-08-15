// Entry point: registers the service worker, wires the PWA install prompt,
// and boots the game.

import { Game } from './game.js';

/* ---------------- PWA plumbing ---------------- */

// Only meaningful when the page is actually hosted. Opened straight off a
// disk there is no origin to scope a worker to, and the single-file build
// needs nothing cached anyway.
const isHosted = location.protocol === 'http:' || location.protocol === 'https:';

if (isHosted && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__wrInstallPrompt = e;
  document.getElementById('installBtn')?.classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
  window.__wrInstallPrompt = null;
  document.getElementById('installBtn')?.classList.add('hidden');
});

/* ---------------- tablet housekeeping ---------------- */

// Stop pinch-zoom and double-tap-zoom from fighting the touch controls.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

// Keep the viewport height honest on mobile browsers with dynamic chrome.
const setVh = () => {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
};
setVh();
window.addEventListener('resize', setVh);
window.addEventListener('orientationchange', () => setTimeout(setVh, 220));

/* ---------------- go ---------------- */

const game = new Game();
window.__game = game;      // handy for debugging from the console

game.boot().catch((err) => {
  console.error(err);
  const t = document.getElementById('loadingText');
  if (t) {
    t.textContent = `Failed to start: ${err.message}`;
    t.style.color = '#ff8b7a';
  }
});
