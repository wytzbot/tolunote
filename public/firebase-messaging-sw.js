/* firebase-messaging-sw.js
 * Handles push notifications for logged-in users while the app is closed
 * or backgrounded. Must be served from the site root (same origin/scope
 * as index.html) as "firebase-messaging-sw.js".
 */

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// Must match the config in index.html.
firebase.initializeApp({
    apiKey: "AIzaSyDTAqb0waoaoSDrwOa2UXRjwl8wmSyXUs0",
    authDomain: "my-wyticle-id.firebaseapp.com",
    projectId: "my-wyticle-id",
    storageBucket: "my-wyticle-id.firebasestorage.app",
    messagingSenderId: "634169882815",
    appId: "1:634169882815:web:486d39a13ce2f855c0ae0a"
});

const messaging = firebase.messaging();

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Background push (app closed or in another tab). The Cloud Function sends
// title/body already AI-composed, so we just display it.
messaging.onBackgroundMessage((payload) => {
    const title = payload.notification?.title || payload.data?.title || 'ToluNote';
    const body = payload.notification?.body || payload.data?.body || '';
    const noteId = payload.data?.noteId || '';

    self.registration.showNotification(title, {
        body,
        icon: 'icons/icon-192.png',
        badge: 'icons/badge-72.png',
        tag: noteId ? `reminder-${noteId}` : undefined,
        data: { noteId },
        vibrate: [100, 50, 100]
    });
});

// Tapping the notification: focus/open the app and tell it which note to open.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const noteId = event.notification.data?.noteId || '';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    client.postMessage({ type: 'OPEN_NOTE', noteId });
                    return client.focus();
                }
            }
            if (self.clients.openWindow) {
                return self.clients.openWindow(noteId ? `/?note=${noteId}` : '/');
            }
        })
    );
});
