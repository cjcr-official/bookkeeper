// Bookkeeper service worker — only handles Web Push for the daily reminder.
// Nothing is cached; the page loads fresh from the network as normal.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { if (event.data) data = event.data.json(); } catch (_) {}
  const title = data.title || 'Bookkeeper';
  const body  = data.body  || 'You have items due today — tap to open.';
  // Also raise the Home Screen app-icon badge so the reminder is visible without
  // opening Notification Center. The app recomputes the exact count on next open.
  const badgeCount = Number(data.badge) > 0 ? Number(data.badge) : 1;
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body,
      icon: 'icon.png',
      badge: 'icon-180.png',
      tag: data.tag || 'bookkeeper-daily',
      data: { url: data.url || '/' }
    }),
    (self.navigator && self.navigator.setAppBadge)
      ? self.navigator.setAppBadge(badgeCount).catch(() => {})
      : Promise.resolve()
  ]));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) { if ('focus' in c) { try { c.navigate(url); } catch(_){} return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
