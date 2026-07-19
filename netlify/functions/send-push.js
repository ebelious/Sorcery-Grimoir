// Sends a push notification to everyone subscribed to an FCM topic
// ('news' | 'discord' | 'youtube' | 'rewards'). Called by the GitHub Actions
// scrapers (scrape-news.js, scrape-discord.js, etc.) after they detect
// something genuinely new -- not called from the client app.
//
// Setup required in the Netlify dashboard (Site settings → Environment
// variables):
//   FIREBASE_SERVICE_ACCOUNT — same value already used by subscribe-topic.js
//     (the full JSON contents of a service account key, as a single-line
//     JSON string).
//   SEND_PUSH_KEY — any long random string you choose. This function checks
//     for it on every request so a stranger who finds this URL can't spam
//     push notifications to all your users. The GitHub Actions workflow
//     that calls this function needs the same value saved as a repo secret
//     (Settings → Secrets and variables → Actions), sent as the
//     x-send-key header.
//
// Setup required locally / in the repo:
//   npm install firebase-admin
//   (package.json + package-lock.json committed so Netlify installs it --
//   already required by subscribe-topic.js, so likely already done)
//
// Request body: { "topic": "news", "title": "...", "body": "...", "url": "(optional deep link)" }

const admin = require('firebase-admin');

const ALL_TOPICS = ['news', 'discord', 'youtube', 'rewards'];

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

  const key = event.headers['x-send-key'] || event.headers['X-Send-Key'];
  if (!process.env.SEND_PUSH_KEY || key !== process.env.SEND_PUSH_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const topic = payload.topic;
  const title = (payload.title || '').trim();
  const body = (payload.body || '').trim();
  const url = payload.url || '';

  if (!ALL_TOPICS.includes(topic)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'topic must be one of: ' + ALL_TOPICS.join(', ') }) };
  }
  if (!title) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing title' }) };
  }

  try {
    const id = await admin.messaging().send({
      topic,
      notification: { title, body },
      data: { section: topic, url }
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, messageId: id })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message })
    };
  }
};
