// Stores and retrieves shared deck lists by a short code, so two players can
// exchange just a deck list -- not a live match -- using the same QR-code /
// manual-code method the Connect match flow (match-sync.js) already uses.
// This is intentionally a completely separate function and Blob store from
// match-sync.js: it never reads or writes match/room state, so there's no
// risk of it interfering with live matches.
//
// Setup required: none beyond what match-sync.js already needs for Netlify
// Blobs on this site (same account/site, no extra environment variables or
// packages -- @netlify/blobs is already a dependency for match-sync.js).
//
// POST body: { "action": "share", "name": "<deck name>", "cards": [{"name":"...","qty":1}, ...] }
//   -> 200 { "code": "AB3D9F2K" }
// GET  ?action=get&code=AB3D9F2K
//   -> 200 { "name": "<deck name>", "cards": [...] }
//   -> 404 { "error": "Deck code not found." } once it's been cleared/expired

const { getStore } = require('@netlify/blobs');

// Excludes 0/O/1/I so a code read off a screen (or handwritten) isn't ambiguous.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const MAX_CARDS = 200; // sanity cap -- a legal Sorcery deck (Spellbook + Atlas) is well under this many distinct entries
const MAX_QTY = 60;

function genCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

exports.handler = async function (event) {
  const store = getStore('sg-shared-decks');

  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    if (params.action !== 'get' || !params.code) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing code' }) };
    }
    const code = String(params.code).toUpperCase().slice(0, CODE_LEN);
    let data;
    try {
      data = await store.get(code, { type: 'json' });
    } catch (e) {
      return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Lookup failed.' }) };
    }
    if (!data) {
      return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Deck code not found.' }) };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: data.name, cards: data.cards })
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (payload.action !== 'share') {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unknown action' }) };
  }

  const name = String(payload.name || 'Shared Deck').slice(0, 120);
  const cards = Array.isArray(payload.cards)
    ? payload.cards.slice(0, MAX_CARDS).map(function (c) {
        return {
          name: String((c && c.name) || '').slice(0, 120),
          qty: Math.max(1, Math.min(MAX_QTY, parseInt(c && c.qty, 10) || 1))
        };
      }).filter(function (c) { return c.name; })
    : [];

  if (!cards.length) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Deck has no cards.' }) };
  }

  // Regenerate on the rare chance of a collision with an existing code.
  let code = genCode();
  for (let i = 0; i < 5; i++) {
    const existing = await store.get(code).catch(function () { return null; });
    if (!existing) break;
    code = genCode();
  }

  await store.setJSON(code, { name: name, cards: cards, createdAt: Date.now() });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code })
  };
};
