// FILE: api/paystack/initialize.js
//
// Starts a Paystack subscription checkout for the $2/month premium plan
// (AI assistant + reminders + speech-to-text). Called from the client's
// "Subscribe" button with the user's Firebase ID token.
//
// REQUIRED VERCEL ENV VARS:
//   PAYSTACK_SECRET_KEY          - your Paystack secret key (sk_...). All
//                                   Paystack API calls here are server-to-
//                                   server, so only the secret key is
//                                   needed — this endpoint never exposes
//                                   any key to the browser. (PAYSTACK_API_KEY
//                                   isn't used by this redirect-based flow;
//                                   if you meant it as your Paystack public
//                                   key, it isn't required here since we
//                                   never load Paystack Inline on the client.)
//   FIREBASE_SERVICE_ACCOUNT_KEY - see api/_lib/firebaseAdmin.js
//   APP_URL                      - e.g. https://tolunote.app (used to build
//                                   the callback_url Paystack redirects to
//                                   after payment). Falls back to the
//                                   request's own host if not set.
//   PAYSTACK_CURRENCY             optional, defaults to "USD". Must be a
//                                  currency enabled on your Paystack account.

import { getAdminDb, getAdminAuth } from '../_lib/firebaseAdmin.js';

const PLAN_AMOUNT = 300000; // 3000 naira in the smallest currency unit (kobo)
const PLAN_INTERVAL = 'monthly';
const PLAN_NAME = 'ToluNote Premium Monthly';

async function paystackFetch(path, options = {}) {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not configured.');

    const res = await fetch(`https://api.paystack.co${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const data = await res.json();
    if (!res.ok || data.status === false) {
        throw new Error(data.message || `Paystack request to ${path} failed`);
    }
    return data;
}

// Reuses a cached plan code if we've already created one, otherwise creates
// the $2/month plan once and caches its code in Firestore.
async function getOrCreatePlanCode(db) {
    const configRef = db.collection('config').doc('paystack');
    const snap = await configRef.get();
    if (snap.exists && snap.data().planCode) {
        return snap.data().planCode;
    }

    const currency = process.env.PAYSTACK_CURRENCY || 'USD';
    const created = await paystackFetch('/plan', {
        method: 'POST',
        body: JSON.stringify({
            name: PLAN_NAME,
            amount: PLAN_AMOUNT,
            interval: PLAN_INTERVAL,
            currency
        })
    });

    const planCode = created.data.plan_code;
    await configRef.set({ planCode, currency, createdAt: Date.now() }, { merge: true });
    return planCode;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { idToken, email } = req.body || {};
    if (!idToken) {
        return res.status(400).json({ error: 'Missing idToken' });
    }

    try {
        const decoded = await getAdminAuth().verifyIdToken(idToken);
        const uid = decoded.uid;
        const userEmail = decoded.email || email;
        if (!userEmail) {
            return res.status(400).json({ error: 'No email on this account to bill.' });
        }

        const db = getAdminDb();
        const planCode = await getOrCreatePlanCode(db);

        const appUrl = process.env.APP_URL || `https://${req.headers.host}`;

        const init = await paystackFetch('/transaction/initialize', {
            method: 'POST',
            body: JSON.stringify({
                email: userEmail,
                amount: PLAN_AMOUNT,
                plan: planCode,
                callback_url: `${appUrl}/?paystack=success`,
                metadata: { uid }
            })
        });

        // Remember which uid this transaction belongs to so the webhook can
        // find its way back to the right Firestore user doc for every event
        // in this subscription's lifecycle (including future renewals).
        await db.collection('paystackTransactions').doc(init.data.reference).set({
            uid,
            email: userEmail,
            createdAt: Date.now()
        });

        return res.status(200).json({ authorization_url: init.data.authorization_url });
    } catch (err) {
        console.error('paystack/initialize error:', err);
        return res.status(500).json({ error: err.message || 'Could not start checkout' });
    }
}
