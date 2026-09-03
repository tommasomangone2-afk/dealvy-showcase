/**
 * public/sw.js
 *
 * Service worker for Dealvy's installable PWA. Served from the site root so it can
 * control the whole origin. Deliberately minimal: it does NOT cache-intercept fetches
 * (see note below) and only handles Web Push — delivering price-alert notifications
 * and routing the click back into the app.
 *
 * Note: comments were translated from Italian for this showcase.
 */

const CACHE_NAME = 'dealvy-v3';

// On install, activate immediately without waiting for old workers to close.
self.addEventListener('install', () => {
  self.skipWaiting();
});

// On activate, drop any old caches and take control of open clients.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

// No fetch handler on purpose: an earlier no-op handler added measurable overhead on
// every navigation. Without one, the browser handles requests normally and the
// service worker stays dedicated to push.

// --- Web Push ----------------------------------------------------------------

// Show a notification when a push arrives (e.g. a tracked product dropped below target).
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};

  const options = {
    body: data.body || 'A product dropped below your target price!',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/notifications' },
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Dealvy', options)
  );
});

// On click, focus an existing tab and navigate it, or open a new window.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.url || '/notifications';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('dealvy.online') && 'focus' in client) {
          client.navigate(path);
          return client.focus();
        }
      }
      return clients.openWindow('https://dealvy.online' + path);
    })
  );
});
