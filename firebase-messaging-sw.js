// ════════════════════════════════════════════════════
// HMS RESOLUTE — push notification service worker
// Must live at the site root (not in a subfolder) so its scope covers the whole app.
// ════════════════════════════════════════════════════
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAXfFW3rWpChcTDqCiFKwk9QIJMY0fhnfw",
  authDomain: "stewart-family-3cece.firebaseapp.com",
  databaseURL: "https://stewart-family-3cece-default-rtdb.firebaseio.com",
  projectId: "stewart-family-3cece",
  storageBucket: "stewart-family-3cece.firebasestorage.app",
  messagingSenderId: "43602660041",
  appId: "1:43602660041:web:0f3d567cc00e7fdf86db18"
});

const messaging = firebase.messaging();

// Same IndexedDB-backed counter as push-notifications.js (service workers
// can't share localStorage with the page, so this has to be duplicated here).
function openBadgeDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('resolute-badge', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('meta');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function bumpBadgeCount(){
  try{
    const db = await openBadgeDB();
    const current = await new Promise((resolve) => {
      const tx = db.transaction('meta','readonly').objectStore('meta').get('count');
      tx.onsuccess = () => resolve(tx.result || 0);
      tx.onerror = () => resolve(0);
    });
    const next = current + 1;
    await new Promise((resolve) => {
      const tx = db.transaction('meta','readwrite').objectStore('meta').put(next, 'count');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
    if('setAppBadge' in navigator) navigator.setAppBadge(next);
  }catch(e){}
}

// Background message handler — fires when the app is closed or in another tab.
messaging.onBackgroundMessage(async (payload) => {
  const title = (payload.data && payload.data.title) || 'HMS Resolute';
  const body = (payload.data && payload.data.body) || 'New message aboard.';
  const relUrl = (payload.data && payload.data.url) || '';
  const targetUrl = new URL(relUrl, self.registration.scope).href;
  const iconUrl = new URL('assets/app-icon-192.png', self.registration.scope).href;

  // Both operations have to actually finish before this handler returns, or
  // the browser can suspend the service worker mid-write and the badge
  // count silently never updates (this was happening before — the previous
  // version fired bumpBadgeCount() without waiting for it at all).
  await Promise.all([
    bumpBadgeCount(),
    self.registration.showNotification(title, {
      body,
      icon: iconUrl,
      badge: iconUrl,
      data: { url: targetUrl }
    })
  ]);
});

// Tapping the notification opens (or focuses) the relevant page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((allClients) => {
      for (const client of allClients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
