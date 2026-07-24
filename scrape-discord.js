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
//   DISCORD_CHANNEL_NAME- (optional) display label override, e.g. "announcements" -- if
//                          unset, the real channel name is looked up from Discord instead

const fs = require('fs');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1215448061850034226';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '278704728999854080';
const CHANNEL_NAME_OVERRIDE = process.env.DISCORD_CHANNEL_NAME || '';
const LIMIT = 10;
const STATE_FILE = 'discord-state.json'; // tracks the last-seen message id, so we only notify on genuinely new messages

// Some messages mention a channel that lives in a *different* Discord server
// than the one this scraper pulls from (e.g. a "#gen-con" channel in a
// separate convention/community server) -- no amount of querying this
// guild's own channels/threads will ever resolve those, since they
// genuinely don't belong to it. Add confirmed id -> name pairs here as
// they come up; the id is the number inside <#...> in the raw message, and
// the name can be read off the discord.com/channels/<guild>/<channel> URL
// (right-click the mention in Discord -> Copy Link, or just click it).
const CROSS_SERVER_CHANNEL_NAMES = {
  '1104864674354303007': 'gen-con',
};

// Resolves Discord's raw mention syntax (<#channelId>, <@userId>, <@&roleId>)
// into readable text. Without this, messages show the literal numeric ID
// (e.g. "<#1104864674354303007>") since that's all Discord's API gives you
// in message.content -- the actual channel/role names have to be looked up
// separately via the guild's channel/role list.
function resolveMentions(content, channelMap, roleMap, userMap) {
  if (!content) return content;
  let s = content;
  s = s.replace(/<#(\d+)>/g, (full, id) => {
    const name = channelMap[id] || CROSS_SERVER_CHANNEL_NAMES[id];
    return name ? '#' + name : full;
  });
  s = s.replace(/<@&(\d+)>/g, (full, id) => roleMap[id] ? '@' + roleMap[id] : full);
  s = s.replace(/<@!?(\d+)>/g, (full, id) => userMap[id] ? '@' + userMap[id] : full);
  return s;
}

// Pulls any image Discord already unfurled from a link in the message
// (Discord auto-generates an embed with a thumbnail/image when a message
// contains a URL it recognizes) so the client can show it inline instead of
// just a bare link.
function findEmbedImages(embeds) {
  if (!Array.isArray(embeds)) return [];
  const out = [];
  embeds.forEach(e => {
    const imgUrl = (e.image && e.image.url) || (e.thumbnail && e.thumbnail.url);
    if (imgUrl) out.push({ url: e.url || null, image: imgUrl });
  });
  return out;
}
function findAttachmentImages(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter(a => a.content_type && a.content_type.indexOf('image/') === 0)
    .map(a => ({ url: null, image: a.url }));
}

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

  // Build id -> name lookup tables for resolving mentions, and for the
  // scraped channel's own display name. Best-effort: if either fetch fails
  // (e.g. bot lacks "View Channels" permission on the guild-wide endpoint),
  // fall back to empty maps rather than aborting -- mentions just stay as
  // raw IDs, and the channel badge falls back to DISCORD_CHANNEL_NAME (or
  // blank) in that case, same as before this change.
  let channelMap = {}, roleMap = {};
  try {
    const chRes = await fetch('https://discord.com/api/v10/guilds/' + GUILD_ID + '/channels', { headers: { Authorization: 'Bot ' + TOKEN } });
    if (chRes.ok) {
      const channels = await chRes.json();
      channels.forEach(c => { if (c.id && c.name) channelMap[c.id] = c.name; });
    } else {
      console.warn('Could not fetch guild channels for mention resolution: HTTP ' + chRes.status);
    }
  } catch (e) { console.warn('Channel lookup failed: ' + e.message); }
  // Threads (e.g. event/announcement threads people get <#mentioned> into)
  // don't show up in the plain /channels list above -- they need this
  // separate endpoint.
  try {
    const thRes = await fetch('https://discord.com/api/v10/guilds/' + GUILD_ID + '/threads/active', { headers: { Authorization: 'Bot ' + TOKEN } });
    if (thRes.ok) {
      const thData = await thRes.json();
      (thData.threads || []).forEach(t => { if (t.id && t.name) channelMap[t.id] = t.name; });
    } else {
      console.warn('Could not fetch active threads for mention resolution: HTTP ' + thRes.status);
    }
  } catch (e) { console.warn('Thread lookup failed: ' + e.message); }
  try {
    const roleRes = await fetch('https://discord.com/api/v10/guilds/' + GUILD_ID + '/roles', { headers: { Authorization: 'Bot ' + TOKEN } });
    if (roleRes.ok) {
      const roles = await roleRes.json();
      roles.forEach(r => { if (r.id && r.name) roleMap[r.id] = r.name; });
    } else {
      console.warn('Could not fetch guild roles for mention resolution: HTTP ' + roleRes.status);
    }
  } catch (e) { console.warn('Role lookup failed: ' + e.message); }

  // Prefer the real channel name from the guild's channel list (already
  // fetched above for mention resolution) over the DISCORD_CHANNEL_NAME env
  // var, which is easy to forget to set and was left blank in production.
  const channelDisplayName = channelMap[CHANNEL_ID] || CHANNEL_NAME_OVERRIDE;

  const messages = raw
    // Skip empty messages (e.g. embed-only or attachment-only with no text)
    .filter(m => (m.content && m.content.trim()) || (m.embeds && m.embeds.length) || (m.attachments && m.attachments.length))
    .map(m => {
      // Per-message user mentions come with the API response already
      // (m.mentions), so no extra request is needed to resolve @user tags.
      const userMap = {};
      (m.mentions || []).forEach(u => { userMap[u.id] = u.global_name || u.username; });
      const rawContent = m.content || (m.embeds && m.embeds[0] && (m.embeds[0].title || m.embeds[0].description)) || '';
      return {
        id: m.id,
        author: (m.author && (m.author.global_name || m.author.username)) || 'Unknown',
        content: resolveMentions(rawContent, channelMap, roleMap, userMap),
        images: findEmbedImages(m.embeds).concat(findAttachmentImages(m.attachments)),
        timestamp: m.timestamp ? new Date(m.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '',
        channel: channelDisplayName,
        url: 'https://discord.com/channels/' + GUILD_ID + '/' + CHANNEL_ID + '/' + m.id,
      };
    });

  if (!messages.length) {
    console.error('No messages found -- channel may be empty or bot lacks access.');
    process.exit(1);
  }

  const output = {
    updated: new Date().toISOString(),
    messages,
  };

  fs.writeFileSync('discord.json', JSON.stringify(output, null, 2));
  console.log('Done -- scraped ' + messages.length + ' messages to discord.json');

  // Notify subscribers when the newest message changes since the last run.
  // Same direct firebase-admin pattern as scrape-youtube.js / scrape-news.js.
  // Skip notifying on the very first run (no prior state to compare
  // against), same reasoning as those scrapers.
  const newest = messages[0];
  let previousId = null;
  try {
    previousId = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastMessageId || null;
  } catch (e) {
    console.log('No existing ' + STATE_FILE + ' -- first run, will not notify');
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    lastMessageId: newest.id,
    updated: new Date().toISOString()
  }, null, 2));

  if (previousId && newest.id !== previousId) {
    try {
      const admin = require('firebase-admin');
      if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      }
      const body = newest.content ? newest.content.slice(0, 140) : 'New Discord update';
      await admin.messaging().send({
        topic: 'discord',
        notification: {
          title: 'Discord: ' + (newest.author || 'New message'),
          body
        },
        android: { priority: 'high' },
        webpush: { headers: { Urgency: 'high' }, fcmOptions: { link: newest.url } }
      });
      console.log('Sent FCM notification for new Discord message: ' + newest.id);
    } catch (e) {
      console.log('FCM notification failed (non-fatal): ' + e.message);
    }
  } else {
    console.log('No new message since last run.');
  }
})();
