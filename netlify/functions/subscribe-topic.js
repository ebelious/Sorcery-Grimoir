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
// Request body:
//   { "token": "<fcm-token>", "topics": ["news","discord","youtube"] }
//     -- syncs the device to exactly this set of the fixed global topics;
//        any of ALL_TOPICS not present gets unsubscribed.
//   { "token": "<fcm-token>", "subscribeTopics": ["store-variant"], "unsubscribeTopics": ["store-old-shop"] }
//     -- for arbitrary per-store topics (favorite-store notifications),
//        which aren't a small fixed set the server can enumerate. The
//        client is responsible for knowing which store topics it wants
//        added/removed (e.g. on favorite/unfavorite), since there's no way
//        to ask FCM which topics a token is currently subscribed to.
// Both forms can be combined in a single request.

const admin = require('firebase-admin');

const ALL_TOPICS = ['news', 'discord', 'youtube', 'rewards'];
const TOPIC_NAME_RE = /^[a-zA-Z0-9\-_.~%]+$/; // FCM's own topic name character restrictions

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
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing token' }) };
  }

  const results = { subscribed: [], unsubscribed: [], errors: [] };

  // Fixed global topics -- full sync (subscribe to what's listed, unsubscribe from the rest of ALL_TOPICS)
  if (Array.isArray(payload.topics)) {
    const wantTopics = payload.topics.filter(t => ALL_TOPICS.includes(t));
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
  }

  // Arbitrary per-store topics -- direct add/remove, no fixed whitelist
  const subscribeTopics = Array.isArray(payload.subscribeTopics) ? payload.subscribeTopics.filter(t => TOPIC_NAME_RE.test(t)) : [];
  const unsubscribeTopics = Array.isArray(payload.unsubscribeTopics) ? payload.unsubscribeTopics.filter(t => TOPIC_NAME_RE.test(t)) : [];

  for (const topic of subscribeTopics) {
    try {
      await admin.messaging().subscribeToTopic(token, topic);
      results.subscribed.push(topic);
    } catch (e) {
      results.errors.push({ topic, message: e.message });
    }
  }
  for (const topic of unsubscribeTopics) {
    try {
      await admin.messaging().unsubscribeFromTopic(token, topic);
      results.unsubscribed.push(topic);
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
