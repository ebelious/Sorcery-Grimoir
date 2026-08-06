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
//   POST { action:'acceptMatch', code, role } -> { code, room }  (both players must accept before the match starts)
//   POST { action:'declineMatch', code, role } -> { code, room }  (the other player gets shown a "declined" popup)
//   POST { action:'proposeResult', code, role, result:{proposerWon,turns,duration} } -> { code, room }
//   POST { action:'confirmResult', code, role } -> { code, room }
//   POST { action:'cancelResult',  code } -> { code, room }  (withdraws a proposed-but-unconfirmed result)
//   POST { action:'setLife', code, role, life } -> { code, room }
//   POST { action:'setDice', code, role, dice:{total,label,brk,ts} } -> { code, room }
//   POST { action:'proposeRematch', code, role } -> { code, room }  (starts the two-phase rematch handshake)
//   POST { action:'confirmRematch', code, role } -> { code, room }  (accepts a pending rematch)
//   POST { action:'cancelRematch',  code } -> { code, room }  (withdraws/declines a pending rematch)
//   POST { action:'rematch', code, role, deck } -> { code, room }  (clears result + life, keeps the room/code --
//                                                                   called by each device once BOTH sides have
//                                                                   accepted via proposeRematch/confirmRematch,
//                                                                   to actually apply that device's deck choice)
//   GET  ?action=get&code=XXXXX -> { code, room }
//
// room shape: { created, p1:{username,deck,life,dice,ts}, p2:{username,deck,life,dice,ts}|null,
//               accepted:{confirmedP1,confirmedP2}|undefined,
//               declined:'p1'|'p2'|null,
//               result:{proposerWon,turns,duration,confirmedP1,confirmedP2}|null,
//               rematch:{confirmedP1,confirmedP2}|null }

const { getStore } = require('@netlify/blobs');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // rooms older than 2h are treated as expired

function genCode() {
  let c = '';
  for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

function _redactRoom(room) {
  if (!room || typeof room !== 'object') return room;
  const r = Object.assign({}, room);
  if (r.p1) { r.p1 = Object.assign({}, r.p1); delete r.p1.usercode; }
  if (r.p2) { r.p2 = Object.assign({}, r.p2); delete r.p2.usercode; }
  return r;
}
function resp(statusCode, obj) {
  // Never expose either player's usercode -- it is the per-device auth secret.
  const safe = (obj && obj.room) ? Object.assign({}, obj, { room: _redactRoom(obj.room) }) : obj;
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(safe)
  };
}

function isExpired(room) {
  return !room || (Date.now() - (room.created || 0)) > MAX_AGE_MS;
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
    ? getStore({ name: 'sg-matches', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN })
    : getStore('sg-matches');

  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = body.action;
      if (body.code != null && !/^[A-Z0-9]{4,12}$/.test(String(body.code).trim().toUpperCase())) return resp(400, { error: 'Invalid code' });
      // SECURITY: authorize mutating actions by the caller's device usercode,
      // not the client-declared role. Look up the caller's real slot and force
      // `role` to it so nobody who merely knows a room code can act as the other
      // player or tear down the room.
      const _member = (rm, uc) => (!rm || !uc) ? null : (rm.p1 && rm.p1.usercode === uc ? 'p1' : (rm.p2 && rm.p2.usercode === uc ? 'p2' : null));
      const _MUT = { acceptMatch: 1, declineMatch: 1, proposeResult: 1, confirmResult: 1, cancelResult: 1, setLife: 1, setDice: 1, leave: 1, proposeRematch: 1, cancelRematch: 1, confirmRematch: 1, rematch: 1 };
      if (_MUT[action]) {
        const _code = (body.code || '').trim().toUpperCase();
        const _uc = (body.usercode || '').trim().slice(0, 20);
        const _room = _code ? await store.get(_code, { type: 'json' }) : null;
        if (_room && !isExpired(_room)) {
          const _r = _member(_room, _uc);
          if (!_r) return resp(403, { error: 'Not authorized for this connection' });
          body.role = _r;
        }
      }

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
        const room = { created: Date.now(), p1: { username, usercode, deck, ts: Date.now() }, p2: null, accepted: { confirmedP1: false, confirmedP2: false } };
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

        if (usercode && room.p1 && room.p1.usercode && room.p1.usercode === usercode) {
          return resp(403, { error: "You can't join your own match. Share the code with someone else instead." });
        }

        room.p2 = { username, usercode, deck, ts: Date.now() };
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'leave') {
        const code = (body.code || '').trim().toUpperCase();
        if (code) await store.delete(code);
        return resp(200, { ok: true });
      }

      // Both players must accept once connected before the match actually
      // starts (the "Match Connected" popup). Symmetric, unlike the
      // propose/confirm result & rematch flows -- there's no "proposer"
      // here, both sides just independently flip their own flag, and each
      // device locally starts the match once it sees both are true.
      if (action === 'acceptMatch') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });

        if (!room.accepted) room.accepted = { confirmedP1: false, confirmedP2: false };
        if (role === 'p1') room.accepted.confirmedP1 = true;
        else room.accepted.confirmedP2 = true;
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      // The other player gets shown "<username> has declined the match" via
      // the poll loop, which reads room.declined and looks up that role's
      // own username from room.p1/p2 -- no need to pass the name separately.
      if (action === 'declineMatch') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });

        room.declined = role;
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'proposeResult') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        const result = body.result || {};
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });

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

      if (action === 'setDice') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        const dice = body.dice || null;
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });
        if (!room[role]) return resp(400, { error: 'Player slot not found' });

        room[role].dice = dice;
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'proposeRematch') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });

        if (room.rematch && !(room.rematch.confirmedP1 && room.rematch.confirmedP2)) {
          return resp(409, { error: 'A rematch is already pending confirmation', code, room });
        }

        room.rematch = { confirmedP1: role === 'p1', confirmedP2: role === 'p2' };
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'confirmRematch') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });
        if (!room.rematch) return resp(400, { error: 'No pending rematch to confirm' });

        if (role === 'p1') room.rematch.confirmedP1 = true;
        else room.rematch.confirmedP2 = true;
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      if (action === 'cancelRematch') {
        const code = (body.code || '').trim().toUpperCase();
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });

        room.rematch = null;
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
        room[role].dice = null;
        room[role].ts = Date.now();
        room.result = null;
        room.rematch = null;
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
