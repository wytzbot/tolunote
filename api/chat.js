// FILE: api/chat.js
//
// AI assistant backend (Groq). Two callers hit this:
//   1. The browser's "Ask AI" modal — gated server-side on an active
//      ad-unlock window (see api/ads/unlock.js) so the gate can't be
//      bypassed by calling this endpoint directly.
//   2. functions/index.js's deliverDueReminders — composes a short
//      notification title/body for a due reminder. Not a user-facing
//      AI-assistant request, so it authenticates instead with a shared
//      secret rather than an ad-unlock check.
//
// REQUIRED VERCEL ENV VARS (in addition to the existing GROQ_KEY):
//   FIREBASE_SERVICE_ACCOUNT_KEY - see api/_lib/firebaseAdmin.js
//   INTERNAL_AI_SECRET           - any long random string. Set the same
//                                   value as the Cloud Function's
//                                   INTERNAL_AI_SECRET param (see
//                                   functions/index.js) so reminder
//                                   delivery keeps working.

import { getAdminAuth, getAdminDb } from './_lib/firebaseAdmin.js';

async function requireAdUnlockOrInternalCall(req) {
    const internalSecret = req.headers['x-internal-secret'];
    if (internalSecret && process.env.INTERNAL_AI_SECRET && internalSecret === process.env.INTERNAL_AI_SECRET) {
        return { ok: true };
    }

    const authHeader = req.headers['authorization'] || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
        return { ok: false, status: 401, error: 'Sign in required to use the AI assistant.' };
    }

    try {
        const decoded = await getAdminAuth().verifyIdToken(idToken);
        const userSnap = await getAdminDb().collection('users').doc(decoded.uid).get();
        const unlock = userSnap.exists ? userSnap.data().adUnlock : null;
        const active = !!(unlock && unlock.active && unlock.expiresAt > Date.now());
        if (!active) {
            return { ok: false, status: 402, error: 'Watch a short ad to unlock the AI assistant.' };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, status: 401, error: 'Could not verify your session. Please sign in again.' };
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const gate = await requireAdUnlockOrInternalCall(req);
    if (!gate.ok) {
        return res.status(gate.status).json({ error: gate.error });
    }

    const { prompt, context } = req.body;
    const apiKey = process.env.GROQ_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'GROQ_KEY is not configured in environment variables.' });
    }

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: [
                    { role: 'system', content: 'You are an expert AI productivity assistant inside ToluNote. Help the user rewrite, summarize, expand, or correct their notes.' },
                    { role: 'user', content: `Context:\n${context}\n\nPrompt: ${prompt}` }
                ],
                temperature: 0.7,
                max_tokens: 1024
            })
        });

        const data = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return res.status(200).json({ response: data.choices[0].message.content });
        } else {
            return res.status(500).json({ error: 'Invalid response from Groq API' });
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
