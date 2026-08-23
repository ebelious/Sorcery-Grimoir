\// Lets two devices connect locally by sharing a short match code: each side
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
//   POST { action:'setTimer', code, role, timer } -> { code, room }  (the room's clock; only the
//         creator writes it, and every reply carries `now` so each device can measure its own
//         clock against the server's -- see the note on `now` below)
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

/* Every reply carries the server's own clock.
   Two phones are rarely set to the same second, and the match clock is stored as a moment
   rather than a countdown -- so a device that took that moment at face value would be out
   by however far its own clock is out. Told what the server thinks the time is, each device
   can measure the difference once and read every moment through it. */
function resp(statusCode, obj) {
  const body = (obj && typeof obj === 'object') ? Object.assign({ now: Date.now() }, obj) : obj;
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
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
        /* How the match is to be played, chosen by whoever starts it and carried on the
           room so the other device is told rather than asked. `play` picks the layout;
           `timer` is the clock a competitive match runs on. Both are plain data -- kept
           narrow here so a bad client cannot write anything it likes onto the room. */
        const play = body.play === 'casual' ? 'casual' : 'competitive';
        const t = body.timer || {};
        const timer = {
          mode: (t.mode === 'countup' || t.mode === 'tug') ? t.mode : 'chess',
          minutes: Math.max(1, Math.min(180, parseInt(t.minutes, 10) || 50))
        };
        const room = { created: Date.now(), play, timer, p1: { username, usercode, deck, ts: Date.now() }, p2: null, accepted: { confirmedP1: false, confirmedP2: false } };
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

      /* How the match is to be played, changed after the room has opened.
         The room opens the moment its page is reached, so the choice is made with the room
         already standing -- it is written here rather than only at the start. Only the
         player who started it may say, and only until the two have accepted: after that the
         match is under way and the layout is not to be pulled from under it. */
      if (action === 'setPlay') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });
        if (role !== 'p1') return resp(200, { code, room });
        const acc = room.accepted || {};
        if (acc.confirmedP1 && acc.confirmedP2) return resp(200, { code, room });

        room.play = body.play === 'casual' ? 'casual' : 'competitive';
        const t = body.timer || {};
        room.timer = {
          mode: (t.mode === 'countup' || t.mode === 'tug') ? t.mode : 'chess',
          minutes: Math.max(1, Math.min(180, parseInt(t.minutes, 10) || 50))
        };
        await store.setJSON(code, room);
        return resp(200, { code, room });
      }

      /* The room's clock.
         One device keeps it -- the one that started the match -- and the other follows, so
         there is never a question of which is right. What is stored is not a countdown but
         the facts a countdown can be worked out from: whether it is running, when it is due
         to end, and what was left on it when it was last stopped. A follower can then work
         out the same figure at any moment without anything being sent between ticks.

         `endsAt` is a moment on the server's clock, not on either device's, so the two
         devices agree even when their own clocks do not -- see `now` in the reply. */
      if (action === 'setTimer') {
        const code = (body.code || '').trim().toUpperCase();
        const role = body.role === 'p2' ? 'p2' : 'p1';
        if (!code) return resp(400, { error: 'Code required' });

        const room = await store.get(code, { type: 'json' });
        if (isExpired(room)) return resp(404, { error: 'Match code not found or expired' });
        /* only the player who started the match keeps the clock */
        if (role !== 'p1') return resp(200, { code, room });

        const t = body.timer || {};
        room.clock = {
          mode: (t.mode === 'countup' || t.mode === 'tug') ? t.mode : 'chess',
          minutes: Math.max(1, Math.min(180, parseInt(t.minutes, 10) || 50)),
          running: !!t.running,
          paused: !!t.paused,
          /* whole milliseconds, and never negative */
          endsAt: Math.max(0, parseInt(t.endsAt, 10) || 0),
          remain: Math.max(0, parseInt(t.remain, 10) || 0),
          pRemain: Array.isArray(t.pRemain) ? t.pRemain.slice(0, 2).map(function (v) { return Math.max(0, parseInt(v, 10) || 0); }) : [0, 0],
          pEnd: Array.isArray(t.pEnd) ? t.pEnd.slice(0, 2).map(function (v) { return v ? Math.max(0, parseInt(v, 10) || 0) : 0; }) : [0, 0],
          activePI: (t.activePI === 0 || t.activePI === 1) ? t.activePI : -1,
          turnNum: Math.max(1, Math.min(9999, parseInt(t.turnNum, 10) || 1)),
          ts: Date.now()
        };
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
