// Live two-player "Share Deck" connection: create/join via the same
// QR-code / manual-code method as match-sync.js, but purely to exchange
// deck lists -- not to run a match. Completely separate function and Blob
// store from match-sync.js; never reads or writes match/room state, so it
// can't affect live matches.
//
// Room shape stored under `code`:
//   {
//     p1: { username, usercode, deck: null, deckConfirmed: false },
//     p2: null | { username, usercode, deck: null, deckConfirmed: false },
//     accepted: { confirmedP1: false, confirmedP2: false },
//     declined: null | 'p1' | 'p2',   // set if either side declines the initial connect popup
//     closed: false,
//     closedBy: null | 'p1' | 'p2',   // set once either side explicitly closes the connection
//     closeReason: null | 'left',
//     createdAt
//   }
//
// Actions (POST unless noted):
//   create      { username, usercode }               -> { code, room }
//   join        { code, username, usercode }          -> { code, room }
//   get (GET)   ?action=get&code=X                     -> { room }
//   accept      { code, role }                         -> { room }
//   decline     { code, role }                         -> { room }
//   selectDeck  { code, role, deck: { name, cards } }   -> { room }
//   close       { code, role }                          -> { room }
//   delete      { code }                                -> { ok: true }
//
// Setup required: none beyond what match-sync.js already needs for Netlify
// Blobs on this site (same account/site, no extra environment variables or
// packages -- @netlify/blobs is already a dependency for match-sync.js).

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

function json(statusCode, obj) {
  return { statusCode: statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function sanitizeDeck(deck) {
  const name = String((deck && deck.name) || 'Shared Deck').slice(0, 120);
  const cards = Array.isArray(deck && deck.cards)
    ? deck.cards.slice(0, MAX_CARDS).map(function (c) {
        return {
          name: String((c && c.name) || '').slice(0, 120),
          qty: Math.max(1, Math.min(MAX_QTY, parseInt(c && c.qty, 10) || 1))
        };
      }).filter(function (c) { return c.name; })
    : [];
  return { name: name, cards: cards };
}

function newPlayer(username, usercode) {
  return {
    username: String(username || 'Player').slice(0, 40),
    usercode: String(usercode || '').slice(0, 40),
    deck: null,
    deckConfirmed: false
  };
}

exports.handler = async function (event) {
  const store = getStore('sg-share-rooms');

  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    if (params.action !== 'get' || !params.code) return json(400, { error: 'Missing code' });
    const code = String(params.code).toUpperCase().slice(0, CODE_LEN);
    const room = await store.get(code, { type: 'json' }).catch(function () { return null; });
    if (!room) return json(404, { error: 'Connection code not found.' });
    return json(200, { room: room });
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid JSON body' });
  }

  const action = payload.action;

  if (action === 'create') {
    let code = genCode();
    for (let i = 0; i < 5; i++) {
      const existing = await store.get(code).catch(function () { return null; });
      if (!existing) break;
      code = genCode();
    }
    const room = {
      p1: newPlayer(payload.username, payload.usercode),
      p2: null,
      accepted: { confirmedP1: false, confirmedP2: false },
      declined: null,
      closed: false,
      closedBy: null,
      closeReason: null,
      createdAt: Date.now()
    };
    await store.setJSON(code, room);
    return json(200, { code: code, room: room });
  }

  if (action === 'join') {
    const code = String(payload.code || '').toUpperCase().slice(0, CODE_LEN);
    if (!code) return json(400, { error: 'Missing code' });
    const room = await store.get(code, { type: 'json' }).catch(function () { return null; });
    if (!room) return json(404, { error: 'Connection code not found.' });
    if (room.closed) return json(400, { error: 'This connection has been closed.' });
    if (!room.p2) {
      room.p2 = newPlayer(payload.username, payload.usercode);
      await store.setJSON(code, room);
    }
    return json(200, { code: code, room: room });
  }

  // Every action below acts on an existing room + role.
  const code = String(payload.code || '').toUpperCase().slice(0, CODE_LEN);
  if (!code) return json(400, { error: 'Missing code' });

  if (action === 'delete') {
    await store.delete(code);
    return json(200, { ok: true });
  }

  const room = await store.get(code, { type: 'json' }).catch(function () { return null; });
  if (!room) return json(404, { error: 'Connection code not found.' });
  const role = payload.role === 'p2' ? 'p2' : 'p1';

  if (action === 'accept') {
    room.accepted = room.accepted || { confirmedP1: false, confirmedP2: false };
    room.accepted[role === 'p1' ? 'confirmedP1' : 'confirmedP2'] = true;
    await store.setJSON(code, room);
    return json(200, { room: room });
  }

  if (action === 'decline') {
    room.declined = role;
    await store.setJSON(code, room);
    return json(200, { room: room });
  }

  if (action === 'selectDeck') {
    if (!room[role]) return json(400, { error: 'You are not part of this connection.' });
    room[role].deck = sanitizeDeck(payload.deck);
    room[role].deckConfirmed = true;
    await store.setJSON(code, room);
    return json(200, { room: room });
  }

  if (action === 'close') {
    room.closed = true;
    room.closedBy = role;
    room.closeReason = 'left';
    await store.setJSON(code, room);
    return json(200, { room: room });
  }

  return json(400, { error: 'Unknown action' });
};
