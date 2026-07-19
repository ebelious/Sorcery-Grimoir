// Checks every channel in YT_CHS (mirror the list in index.html) for new
// videos via YouTube's public per-channel RSS feed (no API key needed), and
// sends a Firebase Cloud Messaging push to the 'youtube' topic when the
// newest video across all channels changes since the last run.
//
// Run on a schedule via GitHub Actions (see scrape-codex.yml for the pattern
// this follows) alongside scrape-news.js / your existing Discord scraper.
//
// Requires:
//   npm install firebase-admin
//   FIREBASE_SERVICE_ACCOUNT env var / GitHub secret (same as scrape-news.js)

const fs = require('fs');

const CHANNELS = [
  { n: 'Ash and Void',         cid: 'UCMHGNiGZo1Isf9cId8FhlXA' },
  { n: 'Cardboard Guide',      cid: 'UCkI76BFK6-hKNI1nndQSp9A' },
  { n: 'Collector Arthouse',   cid: 'UCTyYXZelkHli1vSzDw-OO3Q' },
  { n: 'Common Sense Sorcery', cid: 'UCrCpAOPrsn3iSH7xMyEvwsg' },
  { n: 'Golden Eagle Cards',   cid: 'UCzWglR4ytbyq0aAfWrNaMHw' },
  { n: 'Frogimago',            cid: 'UC4QnfAM-7vpxc4yElHpQoqg' },
  { n: 'Lord of Itza',         cid: 'UC598IUEN4qp8N_KAPkTvx0w' },
  { n: 'OldFashionedNerds',    cid: 'UCRZw6WkGb5O34JCUTPCFvDQ' },
  { n: 'Roaring Turkey',       cid: 'UCcS-iAfvSn1Dub-fpTCFASQ' },
  { n: 'Rose City Sorcery',    cid: 'UCimrNJ_NPy_eb2_Bao7Vpkg' },
  { n: 'Rule 0',               cid: 'UChAaQFWTJbRYMGjiJJKg1TQ' },
  { n: 'Sorcery TCG',          cid: 'UCqmv-SKT0_SO5FbP3vGZ_uQ' },
  { n: 'SRCCompanion',         cid: 'UCN4rG0Cwc8pTdqet0zB96lg' },
  { n: 'The Assorted Animals', cid: 'UCaO-qqRZVlaGvF5AE0EmbNg' },
  { n: 'Trolls of the Realm',  cid: 'UC4gJX4N7f1_QBFjuAbewgfQ' },
  { n: 'The Void',             cid: 'UCSEIoysGSLJ08g6s5BI4v6g' },
  { n: 'Wizards of Fun!',      cid: 'UCFYl70hUINiNPPt-e30v79g' }
];

const STATE_FILE = 'youtube-state.json';

function parseLatestEntry(xml, channelName) {
  // Each <entry>...</entry> block is one video, newest first in the feed.
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) return null;
  const entry = entryMatch[1];
  const videoId = (entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
  const title = (entry.match(/<title>([^<]*)<\/title>/) || [])[1];
  const published = (entry.match(/<published>([^<]+)<\/published>/) || [])[1];
  if (!videoId || !published) return null;
  return {
    channel: channelName,
    videoId,
    title: title || 'New video',
    published,
    ts: new Date(published).getTime() || 0
  };
}

(async () => {
  console.log('Fetching latest video per channel...');
  const results = [];

  for (const ch of CHANNELS) {
    const feedUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + ch.cid;
    try {
      const res = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) {
        console.log('  [' + ch.n + '] HTTP ' + res.status);
        continue;
      }
      const xml = await res.text();
      const latest = parseLatestEntry(xml, ch.n);
      if (latest) {
        results.push(latest);
        console.log('  [' + ch.n + '] ' + latest.title);
      }
    } catch (e) {
      console.log('  [' + ch.n + '] failed -- ' + e.message);
    }
  }

  if (!results.length) {
    console.error('No videos found across any channel -- feeds may be unreachable');
    process.exit(1);
  }

  results.sort((a, b) => b.ts - a.ts);
  const newest = results[0];

  let previousVideoId = null;
  try {
    previousVideoId = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastVideoId || null;
  } catch (e) {
    console.log('No existing ' + STATE_FILE + ' -- first run, will not notify');
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    lastVideoId: newest.videoId,
    updated: new Date().toISOString()
  }, null, 2));

  // Skip notifying on the very first run (no prior state to compare against),
  // same reasoning as scrape-news.js.
  if (previousVideoId && newest.videoId !== previousVideoId) {
    try {
      const admin = require('firebase-admin');
      if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      }
      await admin.messaging().send({
        topic: 'youtube',
        notification: {
          title: 'New video: ' + newest.channel,
          body: newest.title
        },
        android: { priority: 'high' },
        webpush: { headers: { Urgency: 'high' }, fcmOptions: { link: 'https://www.youtube.com/watch?v=' + newest.videoId } }
      });
      console.log('Sent FCM notification for new video: ' + newest.videoId);
    } catch (e) {
      console.log('FCM notification failed (non-fatal): ' + e.message);
    }
  } else {
    console.log('No new video since last run.');
  }
})();
