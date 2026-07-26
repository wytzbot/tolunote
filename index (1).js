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

// Must match the INTERNAL_AI_SECRET env var on the Vercel side (api/chat.js).
// Lets this system call through /api/chat's subscription gate without a
// user login — it's composing a reminder notification, not a user AI request.
const INTERNAL_AI_SECRET = defineString('INTERNAL_AI_SECRET', { default: '' });

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
            headers: {
                'Content-Type': 'application/json',
                'x-internal-secret': INTERNAL_AI_SECRET.value()
            },
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
            const userSnap = await userRef.get();
            const sub = userSnap.exists ? userSnap.data().subscription : null;
            const subscriptionActive = !!(sub && sub.active && (!sub.currentPeriodEnd || sub.currentPeriodEnd > Date.now()));
            if (!subscriptionActive) {
                console.log(`Skipping reminder ${reminderDoc.id}: subscription not active for ${userRef.id}`);
                const next = computeNextOccurrence(reminder.datetime, reminder.repeat);
                await reminderDoc.ref.update(next ? { datetime: next, sent: false, completed: false } : { sent: true, completed: true });
                continue;
            }

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

/**
 * Scheduled Cloud Function: runs twice a day, finds users whose $2/month
 * subscription is renewing/expiring within the next 48 hours and hasn't
 * been warned yet, and pushes a heads-up notification via FCM so they
 * aren't caught off guard by a failed renewal charge or lapsed access.
 */
exports.notifyExpiringSubscriptions = onSchedule('every 12 hours', async () => {
    const now = Date.now();
    const warnWindowEnd = now + 48 * 60 * 60 * 1000;

    const dueSnap = await db.collection('users')
        .where('subscription.active', '==', true)
        .where('subscription.currentPeriodEnd', '<=', warnWindowEnd)
        .where('subscription.currentPeriodEnd', '>', now)
        .limit(200)
        .get();

    if (dueSnap.empty) return;

    for (const userDoc of dueSnap.docs) {
        const sub = userDoc.data().subscription || {};
        if (sub.expiryNotified) continue;

        try {
            const tokensSnap = await userDoc.ref.collection('fcmTokens').get();
            const tokens = tokensSnap.docs.map(d => d.id);
            if (tokens.length === 0) {
                await userDoc.ref.set({ subscription: { expiryNotified: true } }, { merge: true });
                continue;
            }

            const renewDate = new Date(sub.currentPeriodEnd).toLocaleDateString();
            await messaging.sendEachForMulticast({
                tokens,
                notification: {
                    title: '⏳ Your ToluNote Premium renews soon',
                    body: `Your $2/month subscription renews on ${renewDate}. Make sure your payment method is up to date to keep AI, reminders, and voice typing.`
                },
                webpush: { fcmOptions: { link: '/?view=settings' } }
            });

            await userDoc.ref.set({ subscription: { expiryNotified: true } }, { merge: true });
        } catch (err) {
            console.error(`Failed to notify expiring subscription for ${userDoc.id}:`, err);
        }
    }
});
