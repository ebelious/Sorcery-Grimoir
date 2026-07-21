// Lets two devices connect locally by sharing a short match code: each side
// posts their own {username, deck} into a shared "room", and the other side
// polls for it. Backed by Netlify Blobs (free on Netlify's Free plan, no
// credit card, no separate service) instead of Firebase, since Firestore
// requires enabling a Google Cloud billing prompt during setup.
//
// Request shapes:
//   POST { action:'create', username, deck } -> { code, room }
//   POST { action:'join',   code, username, deck } -> { code, room }
//   POST { action:'leave',  code } -> { ok:true }
//   POST { action:'proposeResult', code, role, result:{proposerWon,turns,duration} } -> { code, room }
//   POST { action:'confirmResult', code, role } -> { code, room }
//   POST { action:'cancelResult',  code } -> { code, room }  (withdraws a proposed-but-unconfirmed result)
//   POST { action:'setLife', code, role, life } -> { code, room }
//   POST { action:'rematch', code, role, deck } -> { code, room }  (clears result + life, keeps the room/code)
//   GET  ?action=get&code=XXXXX -> { code, room }
//
// room shape: { created, p1:{username,deck,life,ts}, p2:{username,deck,life,ts}|null,
//               result:{proposerWon,turns,duration,confirmedP1,confirmedP2}|null }

const { getStore } = require('@netlify/blobs');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // rooms older than 2h are treated as expired

function genCode() {
  let c = '';
  for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
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

exports.handler = async function (event) {
  // Requests from a different origin (e.g. GitHub Pages calling this
  // Netlify function) trigger a CORS preflight OPTIONS request before the
  // real POST. Without an explicit 200/204 response with the right headers
  // here, that preflight fails and the browser blocks the actual request.
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

  // getStore('sg-matches') alone relies on Netlify auto-injecting a Blobs
  // context into the function's environment, which isn't happening on this
  // site (throws MissingBlobsEnvironmentError). Falling back to explicit
  // siteID + token fixes that -- these must be added as environment
  // variables in the Netlify dashboard (Site settings -> Environment
  // variables): NETLIFY_SITE_ID (Site settings -> General -> Site details ->
  // Site ID) and NETLIFY_API_TOKEN (a Personal Access Token from User
  // settings -> Applications -> New access token).
  const store = (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN)
    ? getStore({ name: 'sg-matches', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN })
    : getStore('sg-matches');

  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = body.action;

      if (action === 'create') {
        const username = (body.username || '').trim().slice(0, 40);
        const usercode = (body.usercode || '').trim().slice(0, 20);
        const deck = body.deck || null;
        if (!username) return resp(400, { error: 'Username required' });

        let code;
        for (let tries = 0; tries < 5; tries++) {
          code = genCode();
          const existing = await store.get(code, { type: 'json' });
          if (isExpired(existing)) break;
        }
        const room = { created: Date.now(), p1: { username, usercode, deck, ts: Date.now() }, p2: null };
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'join') {
        const code = (body.code || '').trim().toUpperCase();
        const username = (body.username || '').trim().slice(0, 40);
        const usercode = (body.usercode || '').trim().slice(0, 20);
        const deck = body.deck || null;
        if (!code || !username) return resp(400, { error: 'Code and username required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });

        room.p2 = { username, usercode, deck, ts: Date.now() };
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'leave') {
        const code = (body.code || '').trim().toUpperCase();
        if (code) await store.delete(code);
        return resp(200, { ok: true });
      }

      if (action === 'proposeResult') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        const result = body.result || {};
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });

        // If a result is already pending confirmation (proposed by either
        // side, not yet confirmed by both), don't let a second proposal
        // silently overwrite it -- this happens when both players trigger
        // Log Result at nearly the same time. Tell the caller so they can
        // fall back to confirming the existing one instead.
        if (room.result && !(room.result.confirmedP1 && room.result.confirmedP2)) {
          return resp(409, { error: 'A result is already pending confirmation', code, room });
        }

        room.result = {
          proposerWon: !!result.proposerWon,
          turns: result.turns || 0,
          duration: result.duration || null,
          confirmedP1: role === 'p1',
          confirmedP2: role === 'p2'
        };
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'confirmResult') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });
        if (!room.result) return resp(400, { error: 'No pending result to confirm' });

        if (role === 'p1') room.result.confirmedP1 = true;
        else room.result.confirmedP2 = true;
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'cancelResult') {
        const code = (body.code || '').trim().toUpperCase();
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });

        room.result = null;
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'setLife') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        const life = body.life;
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });
        if (!room[role]) return resp(400, { error: 'Player slot not found' });

        room[role].life = life;
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'rematch') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        const deck = body.deck || null;
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });
        if (!room[role]) return resp(400, { error: 'Player slot not found' });

        room[role].deck = deck;
        room[role].life = null;
        room[role].ts = Date.now();
        room.result = null;
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      return resp(400, { error: 'Unknown action' });
    }

    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      const code = (params.code || '').trim().toUpperCase();
      if (!code) return resp(400, { error: 'Code required' });

      const room = await store.get(code, { type: 'json' });
      if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });
      return resp(200, { code, room });
    }

    return resp(405, { error: 'Method Not Allowed' });
  } catch (e) {
    return resp(500, { error: e.message });
  }
};
