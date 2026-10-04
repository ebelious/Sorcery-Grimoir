// Subscribes (or unsubscribes) a device's FCM token to push topics.
//
// Moved off the InstanceId topic subscription API (iid.googleapis.com), which
// Google shuts down on 29 September 2027. firebase-admin's subscribeToTopic()/
// unsubscribeFromTopic() still go through that API, so they are no longer used
// here. This now calls the FCM topic subscription server API directly:
//
//   subscribe    POST   https://fcm.googleapis.com/v1/projects/{project}/registrations/{token}/topicSubscriptions?topic_name={topic}
//   unsubscribe  DELETE https://fcm.googleapis.com/v1/projects/{project}/registrations/{token}/topicSubscriptions/{topic}
//
// (https://firebase.google.com/docs/cloud-messaging/manage-topic-subscriptions)
// One device and one topic per request, authorised with an OAuth access token
// from the same service account as before. firebase-admin is still used, but
// only to hold that service account and mint the token.
//
// Setup required in the Netlify dashboard (Site settings -> Environment
// variables) -- unchanged:
//   FIREBASE_SERVICE_ACCOUNT -- the full JSON contents of a service account
//     key (Firebase Console -> Project Settings -> Service accounts ->
//     Generate new private key), pasted in as a single-line JSON string.
//
// Request body -- unchanged:
//   { "token": "<fcm-token>", "topics": ["news","discord","youtube"] }
//     -- syncs the device to exactly this set of the fixed global topics;
//        any of ALL_TOPICS not present gets unsubscribed.
//   { "token": "<fcm-token>", "subscribeTopics": ["store-variant"], "unsubscribeTopics": ["store-old-shop"] }
//     -- for arbitrary per-store topics (favorite-store notifications),
//        which aren't a small fixed set the server can enumerate. The
//        client is responsible for knowing which store topics it wants
//        added/removed (e.g. on favorite/unfavorite).
// Both forms can be combined in a single request.
//
// Response -- unchanged shape: 200 { subscribed:[...], unsubscribed:[...], errors:[{topic,message}] }
//   "already subscribed" (HTTP 409) counts as subscribed, and "not subscribed"
//   (HTTP 404 on a delete) counts as unsubscribed, as the old API reported
//   both as successes. errors[].message now also carries Google's HTTP status
//   and error status (e.g. "HTTP 400 INVALID_ARGUMENT: ...").

const admin = require('firebase-admin');

const ALL_TOPICS = ['news', 'discord', 'youtube', 'rewards'];
const TOPIC_NAME_RE = /^[a-zA-Z0-9\-_.~%]+$/; // FCM's own topic name character restrictions
const FCM_BASE = 'https://fcm.googleapis.com/v1/projects/';
const REQUEST_TIMEOUT_MS = 8000;              // inside Netlify's 10 s function limit
const MAX_TOKEN_LENGTH = 4096;

let serviceAccount = null;
if (!admin.apps.length) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} else {
  try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch (e) { serviceAccount = null; }
}
const PROJECT_ID = (serviceAccount && serviceAccount.project_id) || process.env.FIREBASE_PROJECT_ID || '';

// An access token, reused while a warm function instance lives, renewed a minute before it expires.
// The requests for one sync run together, so they share a single pending request for the token
// rather than each asking for one.
let _accessToken = null;
let _accessTokenExpires = 0;
let _accessTokenPending = null;
async function accessToken() {
  if (_accessToken && Date.now() < _accessTokenExpires - 60000) return _accessToken;
  if (!_accessTokenPending) {
    _accessTokenPending = admin.app().options.credential.getAccessToken().then((t) => {
      _accessToken = t.access_token;
      _accessTokenExpires = Date.now() + (Number(t.expires_in) || 3600) * 1000;
      return _accessToken;
    }).finally(() => { _accessTokenPending = null; });
  }
  return _accessTokenPending;
}

async function fcmRequest(method, url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Authorization': 'Bearer ' + (await accessToken()), 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
      signal: ctl.signal
    });
    let text = '';
    try { text = await res.text(); } catch (e) { /* no body */ }
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function describeError(r) {
  let detail = '';
  try {
    const j = JSON.parse(r.text || '{}');
    if (j && j.error) detail = (j.error.status ? j.error.status + ': ' : '') + (j.error.message || '');
  } catch (e) { detail = (r.text || '').slice(0, 200); }
  return 'HTTP ' + r.status + (detail ? ' ' + detail : '');
}

function registrationUrl(token) {
  return FCM_BASE + encodeURIComponent(PROJECT_ID) + '/registrations/' + encodeURIComponent(token) + '/topicSubscriptions';
}

// Each returns true on success, or throws an Error whose message describes Google's answer.
async function subscribe(token, topic) {
  const r = await fcmRequest('POST', registrationUrl(token) + '?topic_name=' + encodeURIComponent(topic));
  if ((r.status >= 200 && r.status < 300) || r.status === 409) return true;   // 409: already subscribed
  throw new Error(describeError(r));
}
async function unsubscribe(token, topic) {
  const r = await fcmRequest('DELETE', registrationUrl(token) + '/' + encodeURIComponent(topic));
  if ((r.status >= 200 && r.status < 300) || r.status === 404) return true;   // 404: was not subscribed
  throw new Error(describeError(r));
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
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid token' }) };
  }
  if (!PROJECT_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured (no project_id in FIREBASE_SERVICE_ACCOUNT)' }) };
  }

  const results = { subscribed: [], unsubscribed: [], errors: [] };

  // Every change wanted, in the same order the old function made them in: the fixed global topics
  // first (subscribe what's listed, unsubscribe the rest of ALL_TOPICS), then the per-store ones.
  const jobs = [];
  if (Array.isArray(payload.topics)) {
    const wantTopics = payload.topics.filter(t => ALL_TOPICS.includes(t));
    for (const topic of ALL_TOPICS) jobs.push({ topic, add: wantTopics.includes(topic) });
  }
  const subscribeTopics = Array.isArray(payload.subscribeTopics) ? payload.subscribeTopics.filter(t => typeof t === 'string' && TOPIC_NAME_RE.test(t)) : [];
  const unsubscribeTopics = Array.isArray(payload.unsubscribeTopics) ? payload.unsubscribeTopics.filter(t => typeof t === 'string' && TOPIC_NAME_RE.test(t)) : [];
  for (const topic of subscribeTopics) jobs.push({ topic, add: true });
  for (const topic of unsubscribeTopics) jobs.push({ topic, add: false });

  // The new API takes one topic per request, so they are made together rather than one after
  // another (keeps a full sync well inside the function's time limit); results are reported in
  // the order above.
  const outcomes = await Promise.all(jobs.map(j =>
    (j.add ? subscribe(token, j.topic) : unsubscribe(token, j.topic))
      .then(() => ({ ok: true }), e => ({ ok: false, message: (e && e.name === 'AbortError') ? 'Timed out' : ((e && e.message) || String(e)) }))
  ));
  jobs.forEach((j, i) => {
    const o = outcomes[i];
    if (!o.ok) results.errors.push({ topic: j.topic, message: o.message });
    else if (j.add) results.subscribed.push(j.topic);
    else results.unsubscribed.push(j.topic);
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results)
  };
};
