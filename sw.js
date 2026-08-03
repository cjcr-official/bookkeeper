// Bookkeeper service worker — Web Push for reminders, plus a last-known-good copy
// of the app document so a dropped connection doesn't land on the browser's error
// page. The network ALWAYS wins when it answers, so this can never serve a stale
// build (see the fetch handler).

// Holds only the app document. doUpdate() deletes every cache except 'bk-flags',
// so applying an update clears this automatically — bump the suffix only if the
// stored shape ever changes.
const SHELL_CACHE = 'bk-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// A fetch handler is REQUIRED for Android/Samsung Internet to treat the app as
// installable — without it "Add to Home Screen" makes a plain bookmark (address
// bar stays visible, generic icon) instead of a full-screen WebAPK. It only ever
// sees top-level navigations, so it never interferes with CDN / Supabase requests.
//
// NETWORK-FIRST, cache only as a fallback. This ordering is the whole point: an
// online launch always fetches fresh index.html, so version.json's update prompt
// keeps working exactly as before and nobody gets pinned to a cached build. The
// cached copy is reached only when the network genuinely fails.
//
// NOTE this gets you the app shell offline, not the data — rows live in Supabase
// and still need a connection. The win is a working screen (and a real error
// message) instead of Chrome's dinosaur when service drops mid-errand.
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request)
      .then(res => {
        // Only ever store a genuine 200 — caching a 5xx would make an outage sticky.
        if (res && res.ok && res.status === 200) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put('shell', copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.open(SHELL_CACHE)
        .then(c => c.match('shell'))
        .then(hit => hit || Response.error()))
  );
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
      // Android/Samsung draw `badge` as the small monochrome status-bar glyph and
      // honour vibrate/renotify; iOS ignores all three, so they cost nothing there.
      // renotify + a per-item tag = a second reminder re-alerts instead of
      // silently replacing the first one in the shade.
      badge: 'icon-180.png',
      vibrate: [120, 60, 120],
      renotify: true,
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
  // includeUncontrolled: on Android a freshly-launched WebAPK window can still be
  // uncontrolled when the tap lands; without it matchAll() comes back empty and
  // we open a SECOND copy of the app instead of focusing the one already running.
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { try { c.navigate(url); } catch(_){} return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
