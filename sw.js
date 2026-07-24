// Bookkeeper service worker — only handles Web Push for the daily reminder.
// Nothing is cached; the page loads fresh from the network as normal.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// A fetch handler is REQUIRED for Android/Samsung Internet to treat the app as
// installable — without it "Add to Home Screen" makes a plain bookmark (address
// bar stays visible, generic icon) instead of a full-screen WebAPK. Nothing is
// cached: this is a straight network pass-through, and only for top-level
// navigations so it never interferes with the CDN / Supabase requests.
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
  }
});

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
      : Promise.resolve(),
    // Record that a push arrived, so the app only auto-opens its notifications
    // pane after a real reminder (read on next open) — and nudge any open client.
    markPush(),
    notifyClients()
  ]));
});

// Persist a "a push just arrived" timestamp the page can read on its next open,
// and a live message for any already-open window.
function markPush() {
  return caches.open('bk-flags')
    .then(c => c.put('push', new Response(String(Date.now()))))
    .catch(() => {});
}
function notifyClients() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(cs => cs.forEach(c => { try { c.postMessage({ type: 'bk-push' }); } catch (_) {} }))
    .catch(() => {});
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) { if ('focus' in c) { try { c.navigate(url); } catch(_){} return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
