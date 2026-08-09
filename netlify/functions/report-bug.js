// Relays a bug report from the app into the Sorcery TCG Discord bug forum.
//
// The target is a FORUM channel, so this can't just post a message: every forum
// post is a thread, it needs a title, and this forum has REQUIRE_TAG set so a tag
// must be applied or Discord rejects it with a 400.
//
// This posts as the bot rather than via an incoming webhook, for three reasons:
//   1. Creating a webhook needs Manage Webhooks on someone else's server; posting
//      as the bot only needs Create Posts, which the bot can already be granted.
//   2. The bot can read the forum's available_tags and resolve the tag by NAME,
//      so no snowflake is hardcoded and renaming/reordering tags won't break it.
//   3. Webhook forum-thread creation has a long-standing bug where the first
//      message isn't registered as the thread's original post.
//
// Required Netlify env vars:
//   DISCORD_BOT_TOKEN      - same token discord-feed uses
// Optional:
//   DISCORD_BUG_FORUM_ID   - defaults to the bug forum below
//   DISCORD_BUG_TAG        - tag name to apply, default "bug" (case-insensitive)
//   BUG_REPORT_MAX_PER_HOUR- per-IP cap, default 5
//
// The bot needs, on that forum channel: View Channel, Create Posts,
// Send Messages in Posts, Embed Links, Attach Files.
//
// POST { bug, description, log, images:[{name,data}], meta } -> { ok:true, url }
// "Evidence" is the attachment set (screenshots), not a text field.

const { getStore } = require('@netlify/blobs');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const FORUM_ID = process.env.DISCORD_BUG_FORUM_ID || '1535317688149082142';
const TAG_NAME = (process.env.DISCORD_BUG_TAG || 'bug').toLowerCase();
const GUILD_ID = process.env.DISCORD_GUILD_ID || '278704728999854080';
const MAX_PER_HOUR = parseInt(process.env.BUG_REPORT_MAX_PER_HOUR || '5', 10);
const WINDOW_MS = 60 * 60 * 1000;
const API = 'https://discord.com/api/v10';
const TAG_TTL_MS = 24 * 60 * 60 * 1000;   // re-read available_tags once a day

// Discord's own limits, which we clamp to rather than letting Discord 400 on us.
// thread name is the forum post title and caps at 100.
const LIM = { thread: 100, field: 1000, footer: 2000 };
// Attachment ceilings. The debug log is ~180KB worst case; screenshots are the
// only thing that can get big, and Discord rejects >8MB on an unboosted server.
const MAX_LOG = 400 * 1024;
const MAX_IMG = 3 * 1024 * 1024;        // per screenshot
const MAX_IMG_TOTAL = 4 * 1024 * 1024;  // all screenshots combined
const MAX_FILES = 8;

function cors(extra) {
  return Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, extra || {});
}
function resp(code, obj) { return { statusCode: code, headers: cors(), body: JSON.stringify(obj) }; }
function clip(s, n) {
  s = (s == null ? '' : String(s)).trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Resolve the "bug" tag name to its snowflake by reading the forum's available_tags.
// Cached, because this is an extra round trip on every report and tags change rarely.
async function resolveTagId(store) {
  if (store) {
    try {
      const c = await store.get('tag:' + FORUM_ID, { type: 'json' });
      if (c && c.id && c._ts && (Date.now() - c._ts) < TAG_TTL_MS) return c.id;
    } catch (e) {}
  }
  const r = await fetch(API + '/channels/' + FORUM_ID, { headers: { Authorization: 'Bot ' + TOKEN } });
  if (!r.ok) throw new Error('Could not read the forum channel (HTTP ' + r.status + ') — check the bot can see it');
  const ch = await r.json();
  const tags = ch.available_tags || [];
  const hit = tags.find(t => (t.name || '').toLowerCase() === TAG_NAME)
           || tags.find(t => (t.name || '').toLowerCase().indexOf(TAG_NAME) >= 0);
  if (!hit) throw new Error('No "' + TAG_NAME + '" tag on that forum. Available: ' + (tags.map(t => t.name).join(', ') || 'none'));
  if (store) { try { await store.setJSON('tag:' + FORUM_ID, { id: hit.id, _ts: Date.now() }); } catch (e) {} }
  return hit.id;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors({ 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }), body: '' };
  }
  if (event.httpMethod !== 'POST') return resp(405, { error: 'POST only' });
  if (!TOKEN) return resp(500, { error: 'DISCORD_BOT_TOKEN not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'bad JSON' }); }

  const bug = clip(body.bug, LIM.thread);
  const description = clip(body.description, LIM.field);
  const meta = clip(body.meta, LIM.footer);
  if (!bug && !description) return resp(400, { error: 'Please describe the bug before sending.' });

  // Per-IP throttle. Best-effort: if Blobs is unavailable we'd rather deliver the
  // report than drop it, so a store failure doesn't block the send.
  let store = null;
  try {
    store = (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN)
      ? getStore({ name: 'sg-bugs', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN })
      : getStore('sg-bugs');
  } catch (e) {}
  const ip = (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || event.headers['x-forwarded-for'] || '')).split(',')[0].trim() || 'unknown';
  const rlKey = 'rl:' + ip.replace(/[^\w.:-]/g, '_');
  if (store) {
    try {
      const now = Date.now();
      const prev = (await store.get(rlKey, { type: 'json' })) || { hits: [] };
      const hits = (prev.hits || []).filter(t => now - t < WINDOW_MS);
      if (hits.length >= MAX_PER_HOUR) {
        return resp(429, { error: 'Too many reports sent from this device in the last hour. Please try again later.' });
      }
      hits.push(now);
      await store.setJSON(rlKey, { hits });
    } catch (e) {}
  }

  // Decode the screenshots first: they ARE the evidence, so the summary that goes
  // into the embed and the report file is derived from them.
  const stampEarly = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const shots = [];
  let shotBytes = 0;
  const rawImages = Array.isArray(body.images) ? body.images.slice(0, MAX_FILES) : [];
  rawImages.forEach((im, ix) => {
    try {
      const src = (im && typeof im === 'string') ? im : (im && im.data) || '';
      const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(src);
      if (!m) return;
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_IMG || shotBytes + buf.length > MAX_IMG_TOTAL) return;
      shotBytes += buf.length;
      const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
      shots.push({ name: 'evidence_' + stampEarly + '_' + (ix + 1) + '.' + ext, data: buf, type: m[1], kb: Math.ceil(buf.length / 1024) });
    } catch (e) {}
  });
  const evidence = shots.length
    ? shots.map(sh => '• `' + sh.name + '` (' + sh.kb + ' KB)').join('\n')
    : 'No screenshots attached';

  // Long-form text goes in as a file attachment rather than in the embed, so
  // nothing is silently truncated away by Discord's field limits.
  const reportLines = [
    'BUG: ' + (bug || '(none given)'),
    '',
    'DESCRIPTION:',
    (body.description || '(none given)'),
    '',
    'EVIDENCE (attachments):',
    (shots.length ? shots.map(sh => sh.name + ' (' + sh.kb + ' KB)').join('\n') : '(none attached)'),
    '',
    'META:',
    (body.meta || '(none)')
  ];

  const embed = {
    color: 0xff5555,
    fields: [],
    footer: { text: clip(meta, LIM.footer) || 'no device info' },
    timestamp: new Date().toISOString()
  };
  if (description) embed.fields.push({ name: 'Description', value: description });
  embed.fields.push({ name: 'Evidence', value: clip(evidence, LIM.field) });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const files = [];
  const attachments = [];
  const addFile = (name, data, type) => {
    attachments.push({ id: files.length, filename: name });
    files.push({ field: 'files[' + files.length + ']', name, data, type });
  };

  addFile('report_' + stamp + '.txt', reportLines.join('\n'), 'text/plain');

  const log = typeof body.log === 'string' ? body.log : '';
  if (log) {
    addFile('debug_' + stamp + '.txt', log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log, 'text/plain');
    embed.fields.push({ name: 'Logs', value: 'Attached — `debug_' + stamp + '.txt` (' + Math.ceil(log.length / 1024) + ' KB)' });
  } else {
    embed.fields.push({ name: 'Logs', value: 'None attached (debug logging was off)' });
  }

  shots.forEach(sh => addFile(sh.name, sh.data, sh.type));

  // Tag first: on a REQUIRE_TAG forum, posting without one is a hard 400, so fail
  // with something the user can act on rather than letting Discord's error through.
  let tagId;
  try {
    tagId = await resolveTagId(store);
  } catch (e) {
    return resp(502, { error: e.message });
  }

  const form = new FormData();
  files.forEach(f => form.append(f.field, new Blob([f.data], { type: f.type }), f.name));
  form.append('payload_json', JSON.stringify({
    name: bug || ('Bug report ' + stamp),      // forum post title
    applied_tags: [tagId],
    message: {
      embeds: [embed],
      attachments,
      allowed_mentions: { parse: [] }          // a report's text can never ping the channel
    }
  }));

  try {
    const r = await fetch(API + '/channels/' + FORUM_ID + '/threads', {
      method: 'POST',
      headers: { Authorization: 'Bot ' + TOKEN },
      body: form
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return resp(502, { error: 'Discord rejected the report (HTTP ' + r.status + ')', detail: t.slice(0, 300) });
    }
    const thread = await r.json().catch(() => ({}));
    return resp(200, { ok: true, url: thread.id ? ('https://discord.com/channels/' + GUILD_ID + '/' + thread.id) : '' });
  } catch (err) {
    return resp(502, { error: 'Could not reach Discord: ' + err.message });
  }
};
