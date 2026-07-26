/* firebase-messaging-sw.js
 * Handles push notifications for logged-in users while the app is closed
 * or backgrounded. Must be served from the site root (same origin/scope
 * as index.html) as "firebase-messaging-sw.js".
 */

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// Must match the config in index.html.
firebase.initializeApp({
    apiKey: "AIzaSyBRp0jAxGaV8KbhXSLtDUi7LSspfJ9t-MM",
    authDomain: "tolunote-f74de.firebaseapp.com",
    projectId: "tolunote-f74de",
    storageBucket: "tolunote-f74de.firebasestorage.app",
    messagingSenderId: "124918638921",
    appId: "1:124918638921:web:281b10374b6c557d0b5298"
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
