// Fast deck fetch: tries to get a deck's card list WITHOUT the slow GitHub
// Actions + Playwright pipeline. Two strategies, in order:
//
//   1. Fetch the deck PAGE HTML and deep-search its embedded __NEXT_DATA__
//      JSON for anything shaped like a card entry (a name + a quantity).
//      Curiosa is a Next.js app, so a lot of state is serialised into that
//      blob; if the card list is anywhere in there, this finds it with a
//      single fast HTTP request and no browser.
//   2. If that yields nothing, try a few plausible tRPC procedures directly.
//
// Everything is logged verbosely so that, if neither works, the Netlify
// function log tells us exactly what came back -- rather than guessing. When
// this returns no cards the app falls back to the proven GitHub pipeline, so
// there's no regression.
//
// Request body: { "url": "https://sorcerytcg.com/decks/<id>" }
// Success shape: { ok:true, deckName, author, cards:[{name,qty,zone}], maybeboard:[...] }

const ALLOWED_ORIGINS = [
  'https://ebelious.github.io',
  'https://elaborate-mooncake-835943.netlify.app'
];

function corsHeaders(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

/* The old deck host is gone. The same application was rehosted, so the paths below are
   unchanged and only the host moves -- named once here rather than written out four times,
   so there is a single line to correct if any of them turn out to differ. */
const SITE = 'https://sorcerytcg.com';

const BROWSERISH = {
  'Accept': 'text/html,application/json,*/*',
  'Origin': SITE,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

function extractDeckId(url) {
  const m = String(url || '').match(/\/decks\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

// --- card-entry detection -------------------------------------------------
function looksLikeName(v) {
  return typeof v === 'string' && v.trim().length > 1 && v.trim().length < 80;
}
function nameOf(o) {
  if (!o || typeof o !== 'object') return null;
  if (looksLikeName(o.name)) return o.name.trim();
  if (looksLikeName(o.cardName)) return o.cardName.trim();
  if (o.card && typeof o.card === 'object') {
    if (looksLikeName(o.card.name)) return o.card.name.trim();
    if (looksLikeName(o.card.title)) return o.card.title.trim();
  }
  return null;
}
function qtyOf(o) {
  const q = o.quantity != null ? o.quantity
    : o.qty != null ? o.qty
    : o.count != null ? o.count
    : o.amount != null ? o.amount : null;
  const n = Number(q);
  return (Number.isFinite(n) && n > 0 && n < 1000) ? n : null;
}
function zoneOf(o) {
  const z = o.board || o.zone || o.category || o.section || o.type || '';
  return String(z || '').toLowerCase();
}

// Walk the whole structure and collect every object that carries BOTH a
// card-name and a quantity -- that pattern is what a deck-card entry looks like.
function collectCardEntries(root) {
  const entries = [];
  const seen = new Set();
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 9) return;
    if (Array.isArray(o)) {
      for (const it of o) {
        if (it && typeof it === 'object') {
          const nm = nameOf(it), q = qtyOf(it);
          if (nm && q) {
            const key = nm + '|' + zoneOf(it) + '|' + q;
            if (!seen.has(key)) { seen.add(key); entries.push({ name: nm, qty: q, zone: zoneOf(it) }); }
          }
          walk(it, depth + 1);
        }
      }
      return;
    }
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  })(root, 0);
  return entries;
}

// Curiosa/Sorcery zones: keep a "maybeboard"-like zone separate, everything
// else goes to the main list. (The app matches by name regardless, so exact
// zone naming isn't critical -- this just keeps a maybeboard out of the deck.)
function splitByZone(entries) {
  const cards = [], maybeboard = [];
  for (const e of entries) {
    if (/maybe|sideboard/.test(e.zone)) maybeboard.push({ name: e.name, qty: e.qty });
    else cards.push({ name: e.name, qty: e.qty });
  }
  return { cards, maybeboard };
}

function tryExtractNextData(html) {
  // <script id="__NEXT_DATA__" type="application/json">{...}</script>
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function findDeckName(obj) {
  // shallow-ish search for a plausible deck name/title near the top of the tree
  let found = null;
  (function walk(o, depth) {
    if (found || !o || typeof o !== 'object' || depth > 6) return;
    if (looksLikeName(o.name) && (o.format || o.avatar || o.elements || o.cards || o.deckCards)) { found = o.name.trim(); return; }
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  })(obj, 0);
  return found;
}
function findAuthor(obj) {
  let found = null;
  (function walk(o, depth) {
    if (found || !o || typeof o !== 'object' || depth > 6) return;
    const u = o.user || o.author || o.owner || o.creator;
    if (u && typeof u === 'object' && looksLikeName(u.name || u.username || u.displayName)) {
      found = (u.name || u.username || u.displayName).trim(); return;
    }
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  })(obj, 0);
  return found;
}

exports.handler = async function (event) {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let url;
  try { url = JSON.parse(event.body || '{}').url; } catch (e) {}
  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing url' }) };
  const deckId = extractDeckId(url);
  const pageUrl = deckId ? (SITE + '/decks/' + deckId) : url;

  // ---- Strategy 1: page HTML + __NEXT_DATA__ deep search ----
  try {
    const res = await fetch(pageUrl, { headers: Object.assign({}, BROWSERISH, { 'Accept': 'text/html,*/*' }) });
    const html = await res.text();
    console.log('page fetch status:', res.status, 'html length:', html.length);
    const nextData = tryExtractNextData(html);
    if (nextData) {
      const entries = collectCardEntries(nextData);
      console.log('__NEXT_DATA__ card-entry candidates found:', entries.length);
      if (entries.length) {
        console.log('sample entries:', JSON.stringify(entries.slice(0, 8)));
        const { cards, maybeboard } = splitByZone(entries);
        const deckName = findDeckName(nextData) || 'Imported Deck';
        const author = findAuthor(nextData) || '';
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, source: 'next-data', deckName, author, cards, maybeboard, collection: [] }) };
      }
      console.log('__NEXT_DATA__ present but no card-shaped entries -- cards are likely fetched client-side after hydration.');
    } else {
      console.log('No __NEXT_DATA__ block found in the page HTML.');
    }
  } catch (e) {
    console.log('page-fetch strategy failed:', e.message);
  }

  // ---- Strategy 2: try a few plausible tRPC procedures directly ----
  if (deckId) {
    const candidates = ['deck.getById', 'deck.getCards', 'deck.getContents', 'deck.cards', 'deck.getWithCards'];
    for (const proc of candidates) {
      const apiUrl = SITE + '/api/trpc/' + proc + '?batch=1&input=' +
        encodeURIComponent(JSON.stringify({ '0': { json: { id: deckId } } }));
      try {
        const r = await fetch(apiUrl, { headers: Object.assign({}, BROWSERISH, { 'Accept': 'application/json', 'Referer': pageUrl }) });
        const t = await r.text();
        console.log('[' + proc + '] status ' + r.status + ' body(first 500): ' + t.slice(0, 500));
        if (!r.ok) continue;
        let parsed; try { parsed = JSON.parse(t); } catch (e) { continue; }
        let data = null; try { data = parsed[0].result.data.json; } catch (e) {}
        if (!data) continue;
        const entries = collectCardEntries(data);
        if (entries.length) {
          console.log('[' + proc + '] yielded ' + entries.length + ' card entries.');
          const { cards, maybeboard } = splitByZone(entries);
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, source: proc, deckName: (data.name || 'Imported Deck'), author: findAuthor(data) || '', cards, maybeboard, collection: [] }) };
        }
      } catch (e) {
        console.log('[' + proc + '] request failed:', e.message);
      }
    }
  }

  // Nothing worked -- tell the client to fall back to the GitHub pipeline.
  return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'fast path found no card list; see function logs' }) };
};
