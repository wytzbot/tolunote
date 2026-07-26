// FILE: api/paystack/webhook.js
//
// Paystack webhook endpoint. Configure this URL in the Paystack Dashboard
// under Settings -> API Keys & Webhooks -> Webhook URL:
//   https://<your-domain>/api/paystack/webhook
//
// Keeps users/{uid}.subscription in Firestore in sync with what Paystack
// says is true, for the whole subscription lifecycle — first payment,
// monthly renewals, and cancellations. The client only ever *reads*
// users/{uid}.subscription (see firestore.rules.txt); this is the only
// place that writes it, so the $2/month gate can't be spoofed from the
// browser.
//
// REQUIRED VERCEL ENV VARS:
//   PAYSTACK_SECRET_KEY          - used to verify the x-paystack-signature
//                                   header (HMAC-SHA512 of the raw body).
//   FIREBASE_SERVICE_ACCOUNT_KEY - see api/_lib/firebaseAdmin.js

import crypto from 'crypto';
import { getAdminDb } from '../_lib/firebaseAdmin.js';

// Disable Vercel's default body parsing so we can hash the exact raw bytes
// Paystack sent — signature verification fails on a re-serialized body.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function daysFromNow(days) {
    return Date.now() + days * 24 * 60 * 60 * 1000;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).end();
    }

    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
        console.error('PAYSTACK_SECRET_KEY not configured');
        return res.status(500).end();
    }

    const rawBody = await readRawBody(req);
    const signature = req.headers['x-paystack-signature'];
    const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');

    if (!signature || signature !== expected) {
        console.warn('Paystack webhook: signature mismatch');
        return res.status(401).end();
    }

    let event;
    try {
        event = JSON.parse(rawBody);
    } catch (err) {
        return res.status(400).end();
    }

    const db = getAdminDb();
    const { event: eventType, data } = event;

    try {
        const customerCode = data?.customer?.customer_code || null;

        // Resolve which Firebase user this event belongs to.
        let uid = null;
        if (data?.metadata?.uid) {
            uid = data.metadata.uid;
        } else if (data?.reference) {
            const txSnap = await db.collection('paystackTransactions').doc(data.reference).get();
            if (txSnap.exists) uid = txSnap.data().uid;
        }
        if (!uid && customerCode) {
            const custSnap = await db.collection('paystackCustomers').doc(customerCode).get();
            if (custSnap.exists) uid = custSnap.data().uid;
        }

        if (!uid) {
            console.warn(`Paystack webhook (${eventType}): could not resolve a uid, skipping.`);
            return res.status(200).end(); // Ack so Paystack doesn't retry forever.
        }

        // Remember the mapping for future events that only carry customer_code.
        if (customerCode) {
            await db.collection('paystackCustomers').doc(customerCode).set({ uid }, { merge: true });
        }

        const userRef = db.collection('users').doc(uid);

        switch (eventType) {
            case 'charge.success': {
                await userRef.set({
                    subscription: {
                        active: true,
                        currentPeriodEnd: daysFromNow(31), // refined shortly after by subscription.create
                        customerCode,
                        planCode: data?.plan?.plan_code || null,
                        updatedAt: Date.now(),
                        expiryNotified: false
                    }
                }, { merge: true });
                break;
            }

            case 'subscription.create': {
                const nextPayment = data?.next_payment_date ? new Date(data.next_payment_date).getTime() : daysFromNow(30);
                await userRef.set({
                    subscription: {
                        active: true,
                        currentPeriodEnd: nextPayment,
                        subscriptionCode: data?.subscription_code || null,
                        customerCode,
                        planCode: data?.plan?.plan_code || null,
                        updatedAt: Date.now(),
                        expiryNotified: false
                    }
                }, { merge: true });
                break;
            }

            case 'invoice.update':
            case 'invoice.create': {
                if (data?.paid || data?.status === 'success') {
                    const nextPayment = data?.subscription?.next_payment_date
                        ? new Date(data.subscription.next_payment_date).getTime()
                        : daysFromNow(30);
                    await userRef.set({
                        subscription: {
                            active: true,
                            currentPeriodEnd: nextPayment,
                            updatedAt: Date.now(),
                            expiryNotified: false
                        }
                    }, { merge: true });
                }
                break;
            }

            case 'subscription.not_renew':
            case 'subscription.disable': {
                await userRef.set({
                    subscription: {
                        active: false,
                        updatedAt: Date.now()
                    }
                }, { merge: true });
                break;
            }

            default:
                // Other event types are safe to ignore.
                break;
        }

        return res.status(200).end();
    } catch (err) {
        console.error(`Paystack webhook (${event?.event}) failed:`, err);
        // 200 even on our own processing error so Paystack doesn't hammer
        // retries for a bug on our end; check logs instead.
        return res.status(200).end();
    }
}
