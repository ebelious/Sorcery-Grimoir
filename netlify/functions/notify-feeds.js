// Sends push notifications for new content while the app is CLOSED.
//
// Why this exists: a closed app cannot notice anything. The device-side scrapers
// (news via the NewsScraper plugin, YouTube via the channel RSS feeds, Discord via
// discord-feed) only run while the app is open, so nothing was ever detecting new
// content on a server -- which is why no closed-app push ever arrived even though the
// client, subscribe-topic.js and send-push.js were all finished. This function is the
// missing detector: it runs on a schedule, compares each feed against the last thing
// it saw, and pushes to the matching FCM topic when something is genuinely new.
//
// SCHEDULE -- add to netlify.toml (no extra dependency needed):
//   [functions."notify-feeds"]
//     schedule = "*/15 * * * *"
//
// ENVIRONMENT (Site settings -> Environment variables) -- all already set if
// subscribe-topic.js and send-push.js work:
//   FIREBASE_SERVICE_ACCOUNT   the service-account JSON, single line
//   SEND_PUSH_KEY              required only for MANUAL invocation (see below)
//   NETLIFY_SITE_ID / NETLIFY_API_TOKEN   optional, same as the other functions
//
// MANUAL TESTING (the scheduled run needs no key; a manual call does):
//   curl -X POST https://<site>/.netlify/functions/notify-feeds \
//        -H "x-send-key: $SEND_PUSH_KEY" -H "content-type: application/json" \
//        -d '{"dry":true}'
//   dry:true reports what it WOULD send and writes no state -- run this first.
//
// FIRST RUN sends nothing: it records what is currently latest, so enabling this
// doesn't fire a burst of notifications for content users have already seen.

const admin = require('firebase-admin');
const { getStore } = require('@netlify/blobs');

const STATE_KEY = 'push-state-v1';

const YT_CHANNELS = [
  { n: 'Archives of the Realm',  cid: 'UCjN3qLn5iH2UenbQMNquejQ' },
  { n: 'Ash and Void',           cid: 'UCMHGNiGZo1Isf9cId8FhlXA' },
  { n: 'Cardboard Guide',        cid: 'UCkI76BFK6-hKNI1nndQSp9A' },
  { n: 'Collector Arthouse',     cid: 'UCTyYXZelkHli1vSzDw-OO3Q' },
  { n: 'Common Sense Sorcery',   cid: 'UCrCpAOPrsn3iSH7xMyEvwsg' },
  { n: 'Golden Eagle Cards',     cid: 'UCzWglR4ytbyq0aAfWrNaMHw' },
  { n: 'Frogimago',              cid: 'UC4QnfAM-7vpxc4yElHpQoqg' },
  { n: 'Lord of Itza',           cid: 'UC598IUEN4qp8N_KAPkTvx0w' },
  { n: 'OldFashionedNerds',      cid: 'UCRZw6WkGb5O34JCUTPCFvDQ' },
  { n: 'Roaring Turkey',         cid: 'UCcS-iAfvSn1Dub-fpTCFASQ' },
  { n: 'Rose City Sorcery',      cid: 'UCimrNJ_NPy_eb2_Bao7Vpkg' },
  { n: 'Rule 0',                 cid: 'UChAaQFWTJbRYMGjiJJKg1TQ' },
  { n: 'Sorcery TCG',            cid: 'UCqmv-SKT0_SO5FbP3vGZ_uQ' },
  { n: 'SRCCompanion',           cid: 'UCN4rG0Cwc8pTdqet0zB96lg' },
  { n: 'The Assorted Animals',   cid: 'UCaO-qqRZVlaGvF5AE0EmbNg' },
  { n: 'Trolls of the Realm',    cid: 'UC4gJX4N7f1_QBFjuAbewgfQ' },
  { n: 'The Void',               cid: 'UCSEIoysGSLJ08g6s5BI4v6g' },
  { n: 'Wizards of Fun!',        cid: 'UCFYl70hUINiNPPt-e30v79g' }
];

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

function store() {
  return (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN)
    ? getStore({ name: 'sg-push', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN })
    : getStore('sg-push');
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getText(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'SorceryGrimoire/1.0 (+push checker)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

// ── NEWS ────────────────────────────────────────────────────────────────────
// Mirrors the device's _fetchNewsLive(): pull /news and take the article links.
// Node has no DOMParser, so this is done with a regex over the same markup.
async function checkNews() {
  const html = await getText('https://sorcerytcg.com/news');
  const seen = new Set(), items = [];
  const re = /<a[^>]+href="(\/news\/[^"#?]+)"[^>]*>([\s\S]{0,600}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && items.length < 20) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    const slug = href.replace('/news/', '');
    if (!slug || slug.length < 5) continue;
    const inner = m[2];
    const hm = /<(h[1-4]|p)[^>]*>([\s\S]*?)<\/\1>/i.exec(inner);
    let title = decode((hm ? hm[2] : inner).replace(/<[^>]+>/g, ' '));
    if (!title) title = slug.replace(/[-_]+/g, ' ');
    items.push({ id: 'https://sorcerytcg.com' + href, title: title.slice(0, 140) });
  }
  if (!items.length) throw new Error('no article links found in /news');
  return { topic: 'news', latest: items[0].id,
           title: 'New Sorcery News', body: items[0].title, url: items[0].id };
}

// ── YOUTUBE ─────────────────────────────────────────────────────────────────
// The channel RSS feeds are plain XML and need no API key -- the same source the
// device uses. Checked in parallel; the newest video across all channels wins.
async function checkYouTube() {
  const results = await Promise.all(YT_CHANNELS.map(async ch => {
    try {
      const xml = await getText('https://www.youtube.com/feeds/videos.xml?channel_id=' + ch.cid, 9000);
      const e = xml.split('<entry')[1];
      if (!e) return null;
      const id = (/<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e) || [])[1];
      const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/.exec(e) || [])[1]);
      const pub = (/<published>([^<]+)<\/published>/.exec(e) || [])[1];
      if (!id) return null;
      return { id, title, channel: ch.n, ts: pub ? Date.parse(pub) : 0 };
    } catch (e) { return null; }
  }));
  const vids = results.filter(Boolean).sort((a, b) => b.ts - a.ts);
  if (!vids.length) throw new Error('no channel feeds returned a video');
  const v = vids[0];
  return { topic: 'youtube', latest: v.id,
           title: 'New video: ' + v.channel, body: v.title,
           url: 'https://www.youtube.com/watch?v=' + v.id };
}

// ── DISCORD ─────────────────────────────────────────────────────────────────
// Reuses the app's own discord-feed function rather than talking to Discord
// directly, so the bot token stays in one place.
async function checkDiscord(origin) {
  const base = origin || process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!base) throw new Error('no site URL available for discord-feed');
  const txt = await getText(base.replace(/\/$/, '') + '/.netlify/functions/discord-feed?fresh=1');
  const data = JSON.parse(txt);
  const items = (data && (data.items || data.messages)) || [];
  if (!items.length) throw new Error('discord-feed returned no messages');
  const m = items[0];
  const id = m.id || m.url || m.ts || m.timestamp;
  if (!id) throw new Error('discord message has no id');
  const body = decode(String(m.content || m.text || '')).slice(0, 140);
  return { topic: 'discord', latest: String(id),
           title: 'New in Discord' + (m.author ? ' - ' + m.author : ''),
           body: body || 'A new message was posted.', url: m.url || '' };
}

exports.handler = async function (event) {
  let opts = {};
  try { opts = JSON.parse((event && event.body) || '{}'); } catch (e) {}
  const isScheduled = !!(event && (event.headers || {})['x-nf-event-trigger'] === 'schedule')
    || !!(event && event.body && (() => { try { return JSON.parse(event.body).next_run !== undefined; } catch (e) { return false; } })());
  // The scheduled invocation is NOT authenticated, and Netlify does not guarantee the
  // header this used to rely on. Rejecting an unrecognised caller with 401 meant that
  // if the detection failed, the scheduled run was refused every time and nothing was
  // ever sent -- silently, since nobody reads a cron function's response.
  //
  // So the ordinary check now runs for any caller. That is safe: it can only send when
  // a feed has genuinely changed since the stored state, which is exactly what the
  // schedule would have sent anyway, and it cannot be used to send arbitrary text.
  // The key is still required for anything that overrides that: forcing a resend, or
  // seeding/clearing the stored state.
  const key = (event.headers || {})['x-send-key'] || (event.headers || {})['X-Send-Key'];
  const authed = !!(process.env.SEND_PUSH_KEY && key === process.env.SEND_PUSH_KEY);
  if ((opts.force || opts.reset) && !authed) {
    return { statusCode: 401, body: JSON.stringify({ error: 'force and reset need x-send-key' }) };
  }
  const dry = !!opts.dry;
  const only = Array.isArray(opts.only) ? opts.only : null;

  let st;
  try { st = store(); } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'blob store unavailable: ' + e.message }) };
  }
  let state = {};
  try { state = (await st.get(STATE_KEY, { type: 'json' })) || {}; } catch (e) { state = {}; }
  if (opts.reset) {
    state = {};
    try { await st.setJSON(STATE_KEY, state); } catch (e) {}
  }

  const origin = (event && event.headers && event.headers.host) ? 'https://' + event.headers.host : null;
  const checks = [
    ['news', checkNews],
    ['youtube', checkYouTube],
    ['discord', () => checkDiscord(origin)]
  ].filter(([name]) => !only || only.indexOf(name) >= 0);

  const report = [];
  for (const [name, fn] of checks) {
    try {
      const r = await fn();
      const prev = state[name];
      if (prev === undefined) {
        // First sighting: remember it, never notify. Otherwise enabling this would
        // push the current top item to everyone.
        report.push({ topic: name, action: 'seeded', latest: r.latest, body: r.body });
        if (!dry) state[name] = r.latest;
        continue;
      }
      if (prev === r.latest && !opts.force) {
        report.push({ topic: name, action: 'unchanged', latest: r.latest });
        continue;
      }
      if (dry) {
        report.push({ topic: name, action: 'would send', title: r.title, body: r.body, latest: r.latest, previous: prev });
        continue;
      }
      const messageId = await admin.messaging().send({
        topic: r.topic,
        notification: { title: r.title, body: r.body },
        data: { section: r.topic, url: r.url || '' },
        android: { priority: 'high', notification: { channelId: 'default' } }
      });
      state[name] = r.latest;
      report.push({ topic: name, action: 'sent', messageId, title: r.title, body: r.body });
    } catch (e) {
      // One failing feed must not stop the others.
      report.push({ topic: name, action: 'error', message: e.message });
    }
  }

  if (!dry) {
    try { await st.setJSON(STATE_KEY, state); }
    catch (e) { report.push({ topic: '(state)', action: 'error', message: 'could not save state: ' + e.message }); }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, scheduled: isScheduled, dry, report }, null, 2)
  };
};
