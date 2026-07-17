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
 
  const output = {
    updated: new Date().toISOString(),
    messages,
  };
 
  fs.writeFileSync('discord.json', JSON.stringify(output, null, 2));
  console.log('Done -- scraped ' + messages.length + ' messages to discord.json');
})();
 
