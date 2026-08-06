// Live two-player "Share Deck" connection: create/join via the same
// QR-code / manual-code method as match-sync.js, but purely to exchange
// deck lists -- not to run a match. Completely separate function and Blob
// store from match-sync.js; never reads or writes match/room state, so it
// can't affect live matches. Deliberately mirrors match-sync.js's request/
// response conventions (CORS headers, OPTIONS preflight handling, top-level
// try/catch, Blobs store instantiation) so it behaves identically in this
// site's deployment environment.
//
// Room shape stored under `code`:
//   {
//     created,
//     p1: { username, usercode, decks: [], deckConfirmed: false },
//     p2: null | { username, usercode, decks: [], deckConfirmed: false },
//     accepted: { confirmedP1: false, confirmedP2: false },
//     declined: null | 'p1' | 'p2',   // set if either side declines the initial connect popup
//     closed: false,
//     closedBy: null | 'p1' | 'p2',   // set once either side explicitly closes the connection
//     closeReason: null | 'left'
//   }
//
// Request shapes:
//   POST { action:'create', username, usercode } -> { code, room }
//   POST { action:'join', code, username, usercode } -> { code, room }
//   POST { action:'accept', code, role } -> { code, room }
//   POST { action:'decline', code, role } -> { code, room }
//   POST { action:'selectDeck', code, role, decks:[{name,cards}, ...] } -> { code, room }
//   POST { action:'close', code, role } -> { code, room }
//   POST { action:'delete', code } -> { ok:true }
//   GET  ?action=get&code=XXXXXXXX -> { code, room }

const { getStore } = require('@netlify/blobs');

// Excludes 0/O/1/I so a code read off a screen (or handwritten) isn't ambiguous.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // rooms older than 2h are treated as expired, same as match-sync.js
const MAX_CARDS = 200; // sanity cap -- a legal Sorcery deck (Spellbook + Atlas) is well under this many distinct entries
const MAX_QTY = 60;

function genCode() {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

function resp(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(obj)
  };
}

function isExpired(room) {
  return !room || (Date.now() - (room.created || 0)) > MAX_AGE_MS;
}

const MAX_DECKS_PER_PLAYER = 25; // sanity cap -- no reasonable player shares more decks than this in one connection

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

function sanitizeDecks(decks) {
  return Array.isArray(decks) ? decks.slice(0, MAX_DECKS_PER_PLAYER).map(sanitizeDeck).filter(function (d) { return d.cards.length; }) : [];
}

function newPlayer(username, usercode) {
  return {
    username: (username || '').trim().slice(0, 40),
    usercode: (usercode || '').trim().slice(0, 20),
    decks: [],
    deckConfirmed: false
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }

  const store = (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN)
    ? getStore({ name: 'sg-share-rooms', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN })
    : getStore('sg-share-rooms');

  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = body.action;

      if (action === 'create') {
        const username = (body.username || '').trim().slice(0, 40);
        const usercode = (body.usercode || '').trim().slice(0, 20);
        if (!username) return resp(400, { error: 'Username required' });

        let code;
        for (let tries = 0; tries < 5; tries++) {
          code = genCode();
          const existing = await store.get(code, { type: 'json' });
          if (isExpired(existing)) break;
        }
        const room = {
          created: Date.now(),
          p1: newPlayer(username, usercode),
          p2: null,
          accepted: { confirmedP1: false, confirmedP2: false },
          declined: null,
          closed: false,
          closedBy: null,
          closeReason: null
        };
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'join') {
        const code = (body.code || '').trim().toUpperCase();
        const username = (body.username || '').trim().slice(0, 40);
        const usercode = (body.usercode || '').trim().slice(0, 20);
        if (!code || !username) return resp(400, { error: 'Code and username required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Connection code not found or expired' });
        if (room.closed) return resp(400, { error: 'This connection has been closed.' });

        if (usercode && room.p1 && room.p1.usercode && room.p1.usercode === usercode) {
          return resp(403, { error: "You can't join your own connection. Share the code with someone else instead." });
        }

        if (!room.p2) {
          room.p2 = newPlayer(username, usercode);
          await store.setJSON(code, room);
        } else if (!(room.p2.usercode && usercode && room.p2.usercode === usercode)) {
          // Room already holds a different second device -- only two DISTINCT
          // device codes may join. (The same device re-joining is idempotent.)
          return resp(409, { error: 'Connection is full' });
        }
        return resp(200, { code, room });
      }

      if (action === 'accept') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Connection code not found or expired' });

        if (!room.accepted) room.accepted = { confirmedP1: false, confirmedP2: false };
        if (role === 'p1') room.accepted.confirmedP1 = true;
        else room.accepted.confirmedP2 = true;
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      // The other side gets shown "<username> has declined the connection"
      // via the poll loop, which reads room.declined and looks up that
      // role's own username from room.p1/p2.
      if (action === 'decline') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Connection code not found or expired' });

        room.declined = role;
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'selectDeck') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Connection code not found or expired' });
        if (!room[role]) return resp(400, { error: 'You are not part of this connection.' });

        const decks = sanitizeDecks(body.decks);
        if (!decks.length) return resp(400, { error: 'Choose at least one deck with cards in it.' });
        room[role].decks = decks;
        room[role].deckConfirmed = true;
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      // Closing requires its own explicit confirmation client-side; the
      // other side finds out via the next poll (room.closed/closedBy), same
      // pattern as declineMatch above.
      if (action === 'close') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Connection code not found or expired' });

        room.closed = true;
        room.closedBy = role;
        room.closeReason = 'left';
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'delete') {
        const code = (body.code || '').trim().toUpperCase();
        if (code) await store.delete(code);
        return resp(200, { ok: true });
      }

      return resp(400, { error: 'Unknown action' });
    }

    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      const code = (params.code || '').trim().toUpperCase();
      if (!code) return resp(400, { error: 'Code required' });

      const room = await store.get(code, { type: 'json' });
      if (isExpired(room)) return resp(404, { error: 'Connection code not found or expired' });
      return resp(200, { code, room });
    }

    return resp(405, { error: 'Method Not Allowed' });
  } catch (e) {
    return resp(500, { error: e.message });
  }
};
