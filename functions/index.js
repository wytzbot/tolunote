/**
 * Scheduled Cloud Function: runs every minute, finds due reminders across
 * all logged-in users, asks the AI backend to compose a notification, and
 * sends it via FCM — this is what lets reminders arrive even when the app
 * is fully closed.
 *
 * Requires Node 18+ runtime (uses global fetch).
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

setGlobalOptions({ maxInstances: 5, region: 'us-central1' });

// Set with: firebase functions:config:set or, for v2, deploy-time param.
// Defaults to your same-origin /api/chat endpoint's absolute URL.
const AI_BACKEND_URL = defineString('AI_BACKEND_URL', {
    default: 'https://tolunote.app/api/chat'
});

function fallbackNotificationContent(text) {
    const t = (text || '').toLowerCase();
    if (/bill|payment|electric|invoice|due/.test(t)) {
        return { title: '💡 Bill Reminder', body: 'A payment is due — take care of it now.' };
    }
    if (/study|read|chapter|homework|exam|revise/.test(t)) {
        return { title: '📚 Time to Study!', body: 'A little progress now saves stress later.' };
    }
    if (/meeting|call|zoom|standup/.test(t)) {
        return { title: '🗓️ Meeting Reminder', body: "It's almost time — get ready." };
    }
    if (/medicine|pill|dose|vitamin/.test(t)) {
        return { title: '💊 Health Reminder', body: 'Time to take care of yourself.' };
    }
    return { title: '🔔 Reminder', body: text || 'You have something to do.' };
}

async function generateNotificationContent(reminderText) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(AI_BACKEND_URL.value(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                prompt: `You are writing a push notification for a reminders app. Given this reminder text: "${reminderText}", respond with ONLY minified JSON, no prose, no markdown, in this exact shape: {"emoji":"one relevant emoji","title":"punchy title, max 6 words","body":"one encouraging sentence, max 20 words"}.`,
                context: ''
            })
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`AI backend error ${res.status}`);
        const data = await res.json();
        const raw = (data.response || '').trim().replace(/^```json|```$/g, '').trim();
        const parsed = JSON.parse(raw);
        if (!parsed.title || !parsed.body) throw new Error('Malformed AI response');
        return { title: `${parsed.emoji || '🔔'} ${parsed.title}`, body: parsed.body };
    } catch (err) {
        console.warn('AI compose failed, using fallback:', err.message);
        return fallbackNotificationContent(reminderText);
    }
}

function computeNextOccurrence(datetime, repeat) {
    const d = new Date(datetime);
    switch (repeat) {
        case 'daily': d.setDate(d.getDate() + 1); break;
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'monthly': d.setMonth(d.getMonth() + 1); break;
        case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
        default: return null;
    }
    return d.getTime();
}

exports.deliverDueReminders = onSchedule('every 1 minutes', async () => {
    const now = Date.now();

    const dueSnap = await db.collectionGroup('reminders')
        .where('sent', '==', false)
        .where('datetime', '<=', now)
        .limit(200)
        .get();

    if (dueSnap.empty) return;

    for (const reminderDoc of dueSnap.docs) {
        const reminder = reminderDoc.data();
        const userRef = reminderDoc.ref.parent.parent; // users/{uid}
        if (!userRef) continue;

        try {
            const tokensSnap = await userRef.collection('fcmTokens').get();
            const tokens = tokensSnap.docs.map(d => d.id);
            const content = await generateNotificationContent(reminder.message);

            if (tokens.length > 0) {
                const response = await messaging.sendEachForMulticast({
                    tokens,
                    notification: { title: content.title, body: content.body },
                    data: {
                        noteId: reminder.noteId || '',
                        title: content.title,
                        body: content.body
                    },
                    webpush: {
                        fcmOptions: { link: reminder.noteId ? `/?note=${reminder.noteId}` : '/' }
                    }
                });

                // Clean up dead/unregistered tokens so future sends don't waste time on them.
                response.responses.forEach((r, i) => {
                    const code = r.error?.code;
                    if (!r.success && (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token')) {
                        userRef.collection('fcmTokens').doc(tokens[i]).delete().catch(() => {});
                    }
                });
            }

            const next = computeNextOccurrence(reminder.datetime, reminder.repeat);
            if (next) {
                await reminderDoc.ref.update({ datetime: next, sent: false, completed: false });
            } else {
                await reminderDoc.ref.update({ sent: true, completed: true });
            }
        } catch (err) {
            console.error(`Failed to process reminder ${reminderDoc.id}:`, err);
        }
    }
});
