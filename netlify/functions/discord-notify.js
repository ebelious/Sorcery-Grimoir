// Scheduled Netlify function that replaces the GitHub Actions Discord cron for
// PUSH NOTIFICATIONS. Netlify's scheduler is reliable (GitHub's auto-disables
// after ~60 days of no commits and is delayed under load). Runs every 2 minutes:
// fetches the newest channel message, and if it's new since last time, sends an
// FCM push to the 'discord' topic. The payload carries data.section='discord'
// so tapping the notification opens the app's Discord panel directly.
//
// Required Netlify env vars: DISCORD_BOT_TOKEN, FIREBASE_SERVICE_ACCOUNT
// Optional: DISCORD_CHANNEL_ID, DISCORD_GUILD_ID
//
// Change the cron string below to adjust frequency (min interval is 1 minute).

const { schedule } = require('@netlify/functions');
const { getStore } = require('@netlify/blobs');
const admin = require('firebase-admin');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1215448061850034226';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '278704728999854080';
const API = 'https://discord.com/api/v10';

let _inited = false;
function firebase() {
  if (!_inited) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
    _inited = true;
  }
  return admin;
}

async function latestMessage() {
  const res = await fetch(API + '/channels/' + CHANNEL_ID + '/messages?limit=5', { headers: { Authorization: 'Bot ' + TOKEN } });
  if (!res.ok) throw new Error('Discord HTTP ' + res.status);
  const raw = await res.json();
  return raw.find(m => (m.content && m.content.trim()) || (m.embeds && m.embeds.length) || (m.attachments && m.attachments.length)) || null;
}

const runner = async () => {
  if (!TOKEN || !process.env.FIREBASE_SERVICE_ACCOUNT) return { statusCode: 200, body: 'Not configured' };

  let store = null;
  try { store = (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN) ? getStore({ name: 'sg-discord', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN }) : getStore('sg-discord'); } catch (e) {}

  let m;
  try { m = await latestMessage(); } catch (e) { return { statusCode: 200, body: 'Fetch failed: ' + e.message }; }
  if (!m) return { statusCode: 200, body: 'No messages' };

  let prev = null;
  if (store) { try { const s = await store.get('last-notified', { type: 'json' }); prev = (s && s.id) || null; } catch (e) {} }

  // First run ever: record the current newest and do NOT blast the backlog.
  if (prev === null) {
    if (store) { try { await store.setJSON('last-notified', { id: m.id }); } catch (e) {} }
    return { statusCode: 200, body: 'First run, recorded ' + m.id };
  }
  if (m.id === prev) return { statusCode: 200, body: 'No new message' };

  const link = 'https://discord.com/channels/' + GUILD_ID + '/' + CHANNEL_ID + '/' + m.id;
  try {
    const author = (m.author && (m.author.global_name || m.author.username)) || 'New message';
    const body = (m.content && m.content.trim()) ? m.content.slice(0, 140) : 'New Discord update';
    await firebase().messaging().send({
      topic: 'discord',
      notification: { title: 'Discord: ' + author, body },
      data: { section: 'discord', url: link },
      android: { priority: 'high' },
      webpush: { headers: { Urgency: 'high' }, fcmOptions: { link } }
    });
  } catch (e) {
    return { statusCode: 200, body: 'Send failed: ' + e.message };
  }

  if (store) { try { await store.setJSON('last-notified', { id: m.id }); } catch (e) {} }
  return { statusCode: 200, body: 'Notified ' + m.id };
};

exports.handler = schedule('*/2 * * * *', runner);
