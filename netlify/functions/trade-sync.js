// Connected trading: two devices share a short code; each posts their OWN
// trade side into a shared room and polls for the other's. Modeled on
// match-sync.js (Netlify Blobs) and deliberately separate from it and from
// share-deck.js so it can't affect the working Match/Share features.
//
// Request shapes:
//   POST { action:'create', username, usercode } -> { code, room }
//   POST { action:'join',   code, username, usercode } -> { code, room }
//   POST { action:'accept', code, role } -> { code, room }   (both must accept to connect)
//   POST { action:'setTrade', code, role, trade } -> { code, room }
//         (posts this player's side; if it CHANGED, both players' `confirmed`
//          reset to false so every change needs re-agreement. Unchanged posts
//          -- the ~1.5s live poll -- don't reset anything.)
//   POST { action:'confirm', code, role } -> { code, room }  (this player agrees to the current trade)
//   POST { action:'close',  code, role } -> { ok:true }
//   GET  ?action=get&code=XXXXX -> { code, room }
//
// room shape: { created,
//   p1:{ username, usercode, trade:[...], confirmed:false, ts },
//   p2:{ ... }|null,
//   accepted:{ confirmedP1:false, confirmedP2:false } }

const { getStore } = require('@netlify/blobs');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

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
function isExpired(room) { return !room || (Date.now() - (room.created || 0)) > MAX_AGE_MS; }
function sameTrade(a, b) {
  try { return JSON.stringify(a || []) === JSON.stringify(b || []); } catch (e) { return false; }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }

  const store = (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN)
    ? getStore({ name: 'sg-trades', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN })
    : getStore('sg-trades');

  try {
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      if (params.action === 'get') {
        const code = (params.code || '').trim().toUpperCase();
        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Connection not found or expired' });
        return resp(200, { code, room });
      }
      return resp(400, { error: 'Unknown GET action' });
    }

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
      const room = { created: Date.now(), p1: { username, usercode, trade: [], confirmed: false, ts: Date.now() }, p2: null, accepted: { confirmedP1: false, confirmedP2: false } };
      await store.setJSON(code, room);
      return resp(200, { code, room });
    }

    if (action === 'join') {
      const code = (body.code || '').trim().toUpperCase();
      const username = (body.username || '').trim().slice(0, 40);
      const usercode = (body.usercode || '').trim().slice(0, 20);
      if (!code || !username) return resp(400, { error: 'Code and username required' });
      const room = await store.get(code, { type: 'json' });
      if (isExpired(room)) return resp(404, { error: 'Connection not found or expired' });
      if (room.p2) return resp(409, { error: 'Connection is full' });
      room.p2 = { username, usercode, trade: [], confirmed: false, ts: Date.now() };
      await store.setJSON(code, room);
      return resp(200, { code, room });
    }

    if (action === 'accept') {
      const code = (body.code || '').trim().toUpperCase();
      const role = body.role;
      const room = await store.get(code, { type: 'json' });
      if (isExpired(room)) return resp(404, { error: 'Connection not found or expired' });
      if (!room.accepted) room.accepted = { confirmedP1: false, confirmedP2: false };
      if (role === 'p1') room.accepted.confirmedP1 = true;
      if (role === 'p2') room.accepted.confirmedP2 = true;
      await store.setJSON(code, room);
      return resp(200, { code, room });
    }

    if (action === 'setTrade') {
      const code = (body.code || '').trim().toUpperCase();
      const role = body.role;
      const trade = Array.isArray(body.trade) ? body.trade.slice(0, 300) : [];
      const room = await store.get(code, { type: 'json' });
      if (isExpired(room)) return resp(404, { error: 'Connection not found or expired' });
      const me = role === 'p1' ? room.p1 : room.p2;
      if (!me) return resp(400, { error: 'Player not in room' });
      if (!sameTrade(me.trade, trade)) {
        me.trade = trade;
        me.ts = Date.now();
        // Any change invalidates both sides' agreement.
        if (room.p1) room.p1.confirmed = false;
        if (room.p2) room.p2.confirmed = false;
        await store.setJSON(code, room);
      }
      return resp(200, { code, room });
    }

    if (action === 'confirm') {
      const code = (body.code || '').trim().toUpperCase();
      const role = body.role;
      const room = await store.get(code, { type: 'json' });
      if (isExpired(room)) return resp(404, { error: 'Connection not found or expired' });
      const me = role === 'p1' ? room.p1 : room.p2;
      if (!me) return resp(400, { error: 'Player not in room' });
      me.confirmed = true;
      await store.setJSON(code, room);
      return resp(200, { code, room });
    }

    if (action === 'close') {
      const code = (body.code || '').trim().toUpperCase();
      await store.delete(code);
      return resp(200, { ok: true });
    }

    return resp(400, { error: 'Unknown action' });
  } catch (err) {
    return resp(500, { error: 'Server error: ' + err.message });
  }
};
