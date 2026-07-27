// FILE: api/ads/unlock.js
//
// Grants a temporary "ad unlock" window for the 3 gated features (AI
// assistant, voice typing, reminders). Called from the client after the
// in-page ad wait completes. Writes users/{uid}.adUnlock = { active,
// expiresAt } server-side (via Admin SDK) so the window can't be forged
// or extended from the browser — the client can request a grant, but it
// can never write the field directly (see firestore.rules.txt).
//
// NOTE ON HONESTY: Monetag's In-Page Push format has no "ad completed"
// callback (unlike a native rewarded-video SDK) — it serves impressions
// automatically on its own schedule, not on-demand. This endpoint does
// NOT verify that a specific ad was actually viewed; it only verifies
// that the user waited out the short interval the client enforced. If
// you later get approved for a format with a real reward callback,
// swap the trust boundary here to verify that callback instead.
//
// REQUIRED VERCEL ENV VARS:
//   FIREBASE_SERVICE_ACCOUNT_KEY - see api/_lib/firebaseAdmin.js

import { getAdminAuth, getAdminDb } from '../_lib/firebaseAdmin.js';

const UNLOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const MIN_SECONDS_BETWEEN_GRANTS = 20; // basic anti-spam throttle

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const authHeader = req.headers['authorization'] || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
        return res.status(401).json({ error: 'Sign in required.' });
    }

    try {
        const decoded = await getAdminAuth().verifyIdToken(idToken);
        const uid = decoded.uid;
        const db = getAdminDb();
        const userRef = db.collection('users').doc(uid);

        const snap = await userRef.get();
        const existing = snap.exists ? snap.data().adUnlock : null;
        const now = Date.now();
        if (existing && existing.lastGrantedAt && now - existing.lastGrantedAt < MIN_SECONDS_BETWEEN_GRANTS * 1000) {
            return res.status(429).json({ error: 'Please wait a moment before requesting another unlock.' });
        }

        const expiresAt = now + UNLOCK_DURATION_MS;
        await userRef.set({
            adUnlock: {
                active: true,
                expiresAt,
                lastGrantedAt: now
            }
        }, { merge: true });

        return res.status(200).json({ active: true, expiresAt });
    } catch (err) {
        console.error('ads/unlock error:', err);
        return res.status(401).json({ error: 'Could not verify your session. Please sign in again.' });
    }
}
