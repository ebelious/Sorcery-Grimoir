// Tournament rooms. The organiser creates a room, hands out the code, and players
// join by code with their name and (for Constructed) their deck list.
//
// Authority model -- the whole point of this function:
//   * room.organizer is the creating device's usercode.
//   * ONLY that usercode may publish event state (roster, pairings, results) or
//     close the room. Hiding buttons in the app isn't enough; a modified client
//     could otherwise post results, so the check lives here.
//   * GET redacts every player's deck list unless the caller proves they are the
//     organiser, or it's their own deck. "Only the room creator can see this
//     information" has to be enforced where the data lives.
//
// Storage is Netlify Blobs, same as match-sync/discord-feed. Rooms expire so
// abandoned events don't accumulate.
//
//   POST { action:'create',  usercode, username, name, format }        -> { code, room }
//   POST { action:'join',    code, usercode, username, deck }          -> { code, room }
//   POST { action:'publish', code, usercode, event }                   -> { ok, room }  (organiser only)
//   POST { action:'close',   code, usercode }                          -> { ok }        (organiser only)
//   GET  ?action=get&code=XXXXXX&usercode=YYY                          -> { code, room }

const { getStore } = require('@netlify/blobs');

const TTL_MS = 36 * 60 * 60 * 1000;   // a long event plus overnight
const MAX_PLAYERS = 256;
const MAX_DECK_CARDS = 400;

function cors(extra) {
  return Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, extra || {});
}
function resp(code, obj) { return { statusCode: code, headers: cors(), body: JSON.stringify(obj) }; }
function store() {
  return (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN)
    ? getStore({ name: 'sg-tourney', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN })
    : getStore('sg-tourney');
}
// Ambiguity-free alphabet: no O/0, I/1, so a code read aloud across a shop can't
// be mistyped.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return c;
}
function isExpired(room) { return !room || !room.created || (Date.now() - room.created) > TTL_MS; }
function clean(s, n) { return (s == null ? '' : String(s)).trim().slice(0, n); }

// Decks are trimmed to name+qty: the app only needs those to inspect legality, and
// storing whatever else a client sent would be an injection surface.
function cleanDeck(deck) {
  if (!deck || !Array.isArray(deck.cards)) return null;
  const cards = deck.cards.slice(0, MAX_DECK_CARDS).map(c => ({
    name: clean(c && c.name, 80),
    qty: Math.max(0, Math.min(99, parseInt((c && c.qty) || 0, 10) || 0))
  })).filter(c => c.name);
  if (!cards.length) return null;
  return { name: clean(deck.name, 60), cards: cards };
}

// What a non-organiser is allowed to see: names, pairings, results, standings --
// but no one else's deck list.
function redact(room, usercode) {
  const isOrg = !!usercode && usercode === room.organizer;
  const out = JSON.parse(JSON.stringify(room));
  delete out.organizer;                 // never hand the organiser's secret back
  out.isOrganizer = isOrg;
  if (!isOrg) {
    (out.players || []).forEach(p => {
      const mine = usercode && p.usercode === usercode;
      if (!mine) { delete p.deck; p.deckSubmitted = !!p.deckSubmitted; }
      delete p.usercode;
    });
    if (out.event && out.event.players) {
      out.event.players.forEach(p => { if (!(usercode && p.usercode === usercode)) delete p.deck; delete p.usercode; });
    }
  }
  return out;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors({ 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }), body: '' };
  }
  let st;
  try { st = store(); } catch (e) { return resp(500, { error: 'Room storage unavailable' }); }

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const code = clean(q.code, 12).toUpperCase();
      if (!code) return resp(400, { error: 'Code required' });
      const room = await st.get(code, { type: 'json' });
      if (isExpired(room)) return resp(404, { error: 'Room not found or expired' });
      return resp(200, { code, room: redact(room, clean(q.usercode, 40)) });
    }

    if (event.httpMethod !== 'POST') return resp(405, { error: 'GET or POST only' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'bad JSON' }); }
    const action = body.action;
    const usercode = clean(body.usercode, 40);
    if (!usercode) return resp(400, { error: 'usercode required' });

    if (action === 'create') {
      const username = clean(body.username, 40);
      const name = clean(body.name, 60) || 'Local Event';
      const format = ['constructed', 'sealed', 'draft'].indexOf(body.format) >= 0 ? body.format : 'constructed';
      let code;
      for (let i = 0; i < 6; i++) {
        code = genCode();
        const existing = await st.get(code, { type: 'json' });
        if (isExpired(existing)) break;
      }
      const room = { created: Date.now(), updated: Date.now(), code, name, format,
        organizer: usercode, organizerName: username, open: true, players: [], event: null };
      await st.setJSON(code, room);
      return resp(200, { code, room: redact(room, usercode) });
    }

    const code = clean(body.code, 12).toUpperCase();
    if (!code) return resp(400, { error: 'Code required' });
    const room = await st.get(code, { type: 'json' });
    if (isExpired(room)) return resp(404, { error: 'Room not found or expired' });

    if (action === 'join') {
      if (!room.open) return resp(403, { error: 'Registration for this event is closed' });
      const username = clean(body.username, 40);
      if (!username) return resp(400, { error: 'Name required' });
      const deck = cleanDeck(body.deck);
      room.players = room.players || [];
      // Re-joining from the same device updates that entry instead of duplicating
      // it, so a player can resubmit a corrected deck list.
      const mine = room.players.filter(p => p.usercode === usercode)[0];
      if (mine) {
        mine.name = username; mine.deck = deck || mine.deck;
        mine.deckSubmitted = !!(deck || mine.deck); mine.ts = Date.now();
      } else {
        if (room.players.length >= MAX_PLAYERS) return resp(403, { error: 'This event is full' });
        if (room.players.some(p => p.name.toLowerCase() === username.toLowerCase()))
          return resp(409, { error: 'Someone has already registered under that name' });
        room.players.push({ id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
          usercode, name: username, deck, deckSubmitted: !!deck, source: 'room', ts: Date.now() });
      }
      room.updated = Date.now();
      await st.setJSON(code, room);
      return resp(200, { code, room: redact(room, usercode) });
    }

    // ---- organiser-only from here ----
    if (usercode !== room.organizer) return resp(403, { error: 'Only the event organiser can do that' });

    if (action === 'publish') {
      const ev = body.event;
      if (!ev || typeof ev !== 'object') return resp(400, { error: 'event required' });
      room.event = {
        name: clean(ev.name, 60), format: clean(ev.format, 20), stage: clean(ev.stage, 20),
        plannedRounds: parseInt(ev.plannedRounds || 0, 10) || 0,
        cutSize: parseInt(ev.cutSize || 0, 10) || 0,
        pods: parseInt(ev.pods || 0, 10) || 0,
        // Phase durations, so every device in the room shows the organiser's clock.
        timers: (function (t) {
          if (!t || typeof t !== 'object') return undefined;
          var out = {}, keys = ['draft', 'build', 'packs', 'match', 'round'];
          keys.forEach(function (k) {
            var v = parseInt(t[k], 10);
            if (v > 0 && v <= 180) out[k] = v;
          });
          return Object.keys(out).length ? out : undefined;
        })(ev.timers),
        players: (ev.players || []).slice(0, MAX_PLAYERS).map(p => ({
          id: clean(p.id, 40), name: clean(p.name, 40), dropped: !!p.dropped,
          pod: (p.pod == null ? null : parseInt(p.pod, 10)),
          usercode: clean(p.usercode, 40) || undefined,
          deck: cleanDeck(p.deck) || undefined, deckName: clean(p.deckName, 60) || undefined
        })),
        rounds: (ev.rounds || []).slice(0, 20),
        cut: (ev.cut || []).slice(0, 10)
      };
      room.open = body.open === undefined ? room.open : !!body.open;
      room.updated = Date.now();
      await st.setJSON(code, room);
      return resp(200, { ok: true, code, room: redact(room, usercode) });
    }

    if (action === 'setOpen') {
      room.open = !!body.open; room.updated = Date.now();
      await st.setJSON(code, room);
      return resp(200, { ok: true, code, room: redact(room, usercode) });
    }

    if (action === 'close') {
      await st.delete(code);
      return resp(200, { ok: true });
    }

    return resp(400, { error: 'Unknown action' });
  } catch (err) {
    return resp(500, { error: 'Room error: ' + err.message });
  }
};
