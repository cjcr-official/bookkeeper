// Bookkeeper service worker — only handles Web Push for the daily reminder.
// Nothing is cached; the page loads fresh from the network as normal.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { if (event.data) data = event.data.json(); } catch (_) {}
  const title = data.title || 'Bookkeeper';
  const body  = data.body  || 'You have items due today — tap to open.';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: 'icon.png',
    badge: 'icon-180.png',
    tag: 'bookkeeper-daily',
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) { if ('focus' in c) { try { c.navigate(url); } catch(_){} return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
