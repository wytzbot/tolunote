// FILE: api/_lib/firebaseAdmin.js
//
// Shared Firebase Admin SDK singleton for Vercel serverless functions
// (initialize.js, webhook.js, and chat.js all import this).
//
// REQUIRED VERCEL ENV VAR:
//   FIREBASE_SERVICE_ACCOUNT_KEY — the full JSON content of a service
//   account key, as a single-line string. Generate one at:
//   Firebase Console -> Project Settings -> Service Accounts ->
//   "Generate new private key". Paste the whole JSON file's contents
//   as the env var value (Vercel handles the escaping).
//
// This is separate from the firebaseConfig object in index.html — that
// one is safe to expose to the browser; this service account key is NOT
// and must only ever be read server-side.

import admin from 'firebase-admin';

function getAdminApp() {
    if (admin.apps.length) return admin.apps[0];

    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!raw) {
        throw new Error(
            'FIREBASE_SERVICE_ACCOUNT_KEY is not configured. Add it in Vercel ' +
            'project settings (Firebase Console -> Project Settings -> Service ' +
            'Accounts -> Generate new private key -> paste the JSON as this env var).'
        );
    }

    let serviceAccount;
    try {
        serviceAccount = JSON.parse(raw);
    } catch (err) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON: ' + err.message);
    }

    return admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

export function getAdminDb() {
    getAdminApp();
    return admin.firestore();
}

export function getAdminMessaging() {
    getAdminApp();
    return admin.messaging();
}

export function getAdminAuth() {
    getAdminApp();
    return admin.auth();
}
