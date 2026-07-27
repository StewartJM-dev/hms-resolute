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

// Background message handler — fires when the app is closed or in another tab.
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'HMS Resolute';
  const body = (payload.notification && payload.notification.body) || 'New message aboard.';
  const relUrl = (payload.data && payload.data.url) || '';
  const targetUrl = new URL(relUrl, self.registration.scope).href;
  const iconUrl = new URL('assets/app-icon-192.png', self.registration.scope).href;
  self.registration.showNotification(title, {
    body,
    icon: iconUrl,
    badge: iconUrl,
    data: { url: targetUrl }
  });
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
