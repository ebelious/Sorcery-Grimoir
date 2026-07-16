// Subscribes (or unsubscribes) a device's FCM token to push topics.
//
// The web Firebase SDK can't subscribe a token to a topic by itself — that
// requires the Admin SDK, which needs a service account and must run
// server-side. This function is that server side.
//
// Setup required in the Netlify dashboard (Site settings → Environment
// variables):
//   FIREBASE_SERVICE_ACCOUNT — the full JSON contents of a service account
//     key (Firebase Console → Project Settings → Service accounts →
//     Generate new private key), pasted in as a single-line JSON string.
//
// Setup required locally / in the repo:
//   npm install firebase-admin
//   (package.json + package-lock.json committed so Netlify installs it)
//
// Request body: { "token": "<fcm-token>", "topics": ["news","discord","youtube"] }
// Any of the three topics not present in `topics` will be unsubscribed.

const admin = require('firebase-admin');

const ALL_TOPICS = ['news', 'discord', 'youtube'];

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const token = payload.token;
  const wantTopics = Array.isArray(payload.topics) ? payload.topics.filter(t => ALL_TOPICS.includes(t)) : [];

  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing token' }) };
  }

  const results = { subscribed: [], unsubscribed: [], errors: [] };

  for (const topic of ALL_TOPICS) {
    try {
      if (wantTopics.includes(topic)) {
        await admin.messaging().subscribeToTopic(token, topic);
        results.subscribed.push(topic);
      } else {
        await admin.messaging().unsubscribeFromTopic(token, topic);
        results.unsubscribed.push(topic);
      }
    } catch (e) {
      results.errors.push({ topic, message: e.message });
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results)
  };
};
