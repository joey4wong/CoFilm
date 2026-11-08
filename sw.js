// Minimal service worker so browsers treat CoFilm as an installable app.
// It deliberately caches nothing: the library, ratings and player always come fresh from the network,
// so a new release can never be hidden behind an old cached copy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
