// Live Discord channel feed for the app to call on demand -- no cron needed
// for display. The bot token stays server-side (Netlify env var) and never
// ships in the app. Output matches scrape-discord.js so the app renders it
// identically. A 60s Netlify Blobs cache caps how often we hit Discord's API,
// so it's safe no matter how many users open the panel at once.
//
// Required Netlify env var: DISCORD_BOT_TOKEN
// Optional: DISCORD_CHANNEL_ID, DISCORD_GUILD_ID, DISCORD_CHANNEL_NAME, DISCORD_MSG_LIMIT
//
// GET -> { messages:[ { id, author, content, images:[{url,image}], timestamp, channel, url } ], updated, cached }

const { getStore } = require('@netlify/blobs');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1215448061850034226';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '278704728999854080';
const CHANNEL_NAME_OVERRIDE = process.env.DISCORD_CHANNEL_NAME || '';
const LIMIT = parseInt(process.env.DISCORD_MSG_LIMIT || '30', 10);
const CROSS_SERVER_CHANNEL_NAMES = {};
// 20s, not 60s: the app re-polls this every 30s while the Discord panel is open,
// so a 60s TTL meant a message could sit ~90s behind. At 20s the worst case is
// one poll interval. Discord's channel-messages limit is 50 req/s per route, and
// this caps us at 3/min no matter how many devices are open, so there's headroom.
const CACHE_TTL_MS = 20 * 1000;
const API = 'https://discord.com/api/v10';

function cors(extra) { return Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, extra || {}); }
function resp(code, obj) { return { statusCode: code, headers: cors(), body: JSON.stringify(obj) }; }

function resolveMentions(content, channelMap, roleMap, userMap) {
  if (!content) return content;
  let s = content;
  s = s.replace(/<#(\d+)>/g, (full, id) => { const n = channelMap[id] || CROSS_SERVER_CHANNEL_NAMES[id]; return n ? '#' + n : full; });
  s = s.replace(/<@&(\d+)>/g, (full, id) => (roleMap[id] ? '@' + roleMap[id] : full));
  s = s.replace(/<@!?(\d+)>/g, (full, id) => (userMap[id] ? '@' + userMap[id] : full));
  return s;
}
function findEmbedImages(embeds) {
  if (!Array.isArray(embeds)) return [];
  const out = [];
  embeds.forEach(e => { const u = (e.image && e.image.url) || (e.thumbnail && e.thumbnail.url); if (u) out.push({ url: e.url || null, image: u }); });
  return out;
}
// This app's channel FOLLOWS the real announcement channel, so what lands here is a
// crosspost: a copy with its own local id. Discord attaches `message_reference` to
// that copy pointing at the ORIGINAL (source guild/channel/message), and flags it
// IS_CROSSPOST (1 << 1). Linking to the local copy sends a reader to our mirror
// rather than the real thread, so prefer the reference whenever it is present and
// complete. Anything posted directly in our own channel has no reference and still
// links to itself, exactly as before.
const FLAG_IS_CROSSPOST = 1 << 1;
function permalinkFor(m) {
  const ref = m && m.message_reference;
  if (ref && ref.message_id && ref.channel_id && ref.guild_id) {
    return 'https://discord.com/channels/' + ref.guild_id + '/' + ref.channel_id + '/' + ref.message_id;
  }
  return 'https://discord.com/channels/' + GUILD_ID + '/' + CHANNEL_ID + '/' + m.id;
}
function isCrosspost(m) {
  return !!(m && (((m.flags || 0) & FLAG_IS_CROSSPOST) || (m.message_reference && m.message_reference.message_id)));
}

function findAttachmentImages(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(a => a.content_type && a.content_type.indexOf('image/') === 0).map(a => ({ url: null, image: a.url }));
}

async function buildFeed() {
  const auth = { headers: { Authorization: 'Bot ' + TOKEN } };
  const res = await fetch(API + '/channels/' + CHANNEL_ID + '/messages?limit=' + LIMIT, auth);
  if (!res.ok) throw new Error('Discord API HTTP ' + res.status);
  const raw = await res.json();

  let channelMap = {}, roleMap = {};
  try { const r = await fetch(API + '/guilds/' + GUILD_ID + '/channels', auth); if (r.ok) (await r.json()).forEach(c => { if (c.id && c.name) channelMap[c.id] = c.name; }); } catch (e) {}
  try { const r = await fetch(API + '/guilds/' + GUILD_ID + '/threads/active', auth); if (r.ok) ((await r.json()).threads || []).forEach(t => { if (t.id && t.name) channelMap[t.id] = t.name; }); } catch (e) {}
  try { const r = await fetch(API + '/guilds/' + GUILD_ID + '/roles', auth); if (r.ok) (await r.json()).forEach(ro => { if (ro.id && ro.name) roleMap[ro.id] = ro.name; }); } catch (e) {}

  const channelDisplayName = channelMap[CHANNEL_ID] || CHANNEL_NAME_OVERRIDE;
  const messages = raw
    .filter(m => (m.content && m.content.trim()) || (m.embeds && m.embeds.length) || (m.attachments && m.attachments.length))
    .map(m => {
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
        url: permalinkFor(m),
        // so the client can tell a mirrored post from one of our own
        crosspost: isCrosspost(m)
      };
    });
  return { messages, updated: new Date().toISOString() };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors({ 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }), body: '' };
  if (!TOKEN) return resp(500, { error: 'DISCORD_BOT_TOKEN not configured' });

  let store = null;
  try { store = (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN) ? getStore({ name: 'sg-discord', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN }) : getStore('sg-discord'); } catch (e) {}

  // Serve a recent cached copy if it's fresh, to protect Discord's rate limit.
  if (store) {
    try {
      const cached = await store.get('feed', { type: 'json' });
      if (cached && cached._ts && (Date.now() - cached._ts) < CACHE_TTL_MS) {
        return resp(200, { messages: cached.messages, updated: cached.updated, cached: true });
      }
    } catch (e) {}
  }

  try {
    const feed = await buildFeed();
    if (store) { try { await store.setJSON('feed', Object.assign({ _ts: Date.now() }, feed)); } catch (e) {} }
    return resp(200, Object.assign({ cached: false }, feed));
  } catch (err) {
    // On failure, fall back to the last cached copy if we have one.
    if (store) { try { const c = await store.get('feed', { type: 'json' }); if (c && c.messages) return resp(200, { messages: c.messages, updated: c.updated, cached: true, stale: true }); } catch (e) {} }
    return resp(502, { error: 'Discord fetch failed: ' + err.message });
  }
};
