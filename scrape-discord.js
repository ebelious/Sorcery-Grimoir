// Fetches recent messages from a channel on Sorcery TCG's official Discord server
// (discord.gg/sorcerytcg) using the Discord REST API, and writes them to discord.json,
// which the client fetches the same way it fetches news.json (same-origin static JSON —
// no live API calls from the browser, since Discord's API requires a bot token that must
// never ship to the client).
//
// Run via GitHub Actions on a schedule, same as scrape-news.js / scrape-prices.js.
//
// Required environment variables (set as GitHub Actions secrets):
//   DISCORD_BOT_TOKEN   - a bot token for a bot invited to the official Sorcery TCG
//                          Discord server, with "Read Message History" on the target channel
//   DISCORD_CHANNEL_ID  - (optional) defaults to 1215448061850034226, the specific channel
//                          this scraper was set up to pull updates from
//   DISCORD_GUILD_ID    - (optional) defaults to 278704728999854080, the official Sorcery
//                          TCG server, used to build a "jump to message" link
//   DISCORD_CHANNEL_NAME- (optional) display label, e.g. "announcements"

const fs = require('fs');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1215448061850034226';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '278704728999854080';
const CHANNEL_NAME = process.env.DISCORD_CHANNEL_NAME || '';
const LIMIT = 10;

(async () => {
  if (!TOKEN || !CHANNEL_ID) {
    console.error('Missing DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID -- aborting.');
    process.exit(1);
  }

  console.log('Fetching messages from Discord channel ' + CHANNEL_ID + '...');

  const res = await fetch(
    'https://discord.com/api/v10/channels/' + CHANNEL_ID + '/messages?limit=' + LIMIT,
    { headers: { Authorization: 'Bot ' + TOKEN } }
  );

  if (!res.ok) {
    console.error('Discord API error: HTTP ' + res.status + ' -- ' + (await res.text()));
    process.exit(1);
  }

  const raw = await res.json();

  const messages = raw
    // Skip empty messages (e.g. embed-only or attachment-only with no text)
    .filter(m => (m.content && m.content.trim()) || (m.embeds && m.embeds.length) || (m.attachments && m.attachments.length))
    .map(m => ({
      id: m.id,
      author: (m.author && (m.author.global_name || m.author.username)) || 'Unknown',
      content: m.content || (m.embeds && m.embeds[0] && (m.embeds[0].title || m.embeds[0].description)) || '',
      timestamp: m.timestamp ? new Date(m.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '',
      channel: CHANNEL_NAME,
      url: 'https://discord.com/channels/' + GUILD_ID + '/' + CHANNEL_ID + '/' + m.id,
    }));

  if (!messages.length) {
    console.error('No messages found -- channel may be empty or bot lacks access.');
    process.exit(1);
  }

  // Capture the previously-known message IDs before overwriting, to detect
  // genuinely new messages since the last run.
  let previousIds = null;
  try {
    const existing = JSON.parse(fs.readFileSync('discord.json', 'utf8'));
    if (Array.isArray(existing.messages)) {
      previousIds = new Set(existing.messages.map(m => m.id));
    }
  } catch (e) {
    console.log('No existing discord.json -- first run, will not notify');
  }

  const output = {
    updated: new Date().toISOString(),
    messages,
  };

  fs.writeFileSync('discord.json', JSON.stringify(output, null, 2));
  console.log('Done -- scraped ' + messages.length + ' messages to discord.json');

  // Notify subscribers via Firebase Cloud Messaging if any message wasn't
  // present last run. `previousIds` is null on the very first run (no
  // discord.json yet) -- skip notifying in that case so setup doesn't blast
  // everyone with the whole recent history at once. Same direct
  // firebase-admin pattern as scrape-youtube.js / scrape-rewards.js.
  if (previousIds) {
    const newMessages = messages.filter(m => !previousIds.has(m.id));
    if (newMessages.length) {
      try {
        const admin = require('firebase-admin');
        if (!admin.apps.length) {
          const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
          admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        }
        const first = newMessages[0];
        await admin.messaging().send({
          topic: 'discord',
          notification: {
            title: newMessages.length === 1 ? (first.author + ' in Discord') : (newMessages.length + ' new Discord messages'),
            body: newMessages.length === 1 ? first.content.slice(0, 120) : first.content.slice(0, 80)
          },
          android: { priority: 'high' },
          webpush: { headers: { Urgency: 'high' }, fcmOptions: { link: first.url } }
        });
        console.log('Sent FCM notification for ' + newMessages.length + ' new message(s)');
      } catch (e) {
        console.log('FCM notification failed (non-fatal): ' + e.message);
      }
    } else {
      console.log('No new messages since last run.');
    }
  }
})();
