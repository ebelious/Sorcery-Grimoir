// Fetches a single deck's data via Curiosa's tRPC API directly, using the
// confirmed real procedure name and input shape (found in a deck page's
// __NEXT_DATA__ dehydrated query state):
//   queryKey: [["deck","getById"], {"input":{"id":"<deckId>"},"type":"query"}]
// Uses the same origin-spoofing technique already confirmed working for
// deck.search in search-community-decks.js (Curiosa's API rejects requests
// that don't look like they're coming from their own frontend).
//
// STATUS: the SSR-embedded version of this exact query (seen in a real
// page's __NEXT_DATA__) only contained metadata (name/format/avatar/
// elements/like+view counts) -- no card list. Since that dehydrated state
// should mirror what this live call returns, there's a real chance this
// still won't include the card list, meaning a different procedure (maybe
// something like deck.getCards, or nested elsewhere) is what actually
// fetches it. This logs the complete raw response either way so that can
// be confirmed definitively rather than guessed at again. If this path
// doesn't pan out, the app falls back to the existing (slower, proven)
// GitHub Actions pipeline automatically.
//
// Request body: { "url": "https://curiosa.io/decks/<deckId>" }

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
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function extractDeckId(url) {
  const m = url.match(/\/decks\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

// Tries several plausible field names/paths for a card list, since the
// actual location (if this procedure includes one at all) is unconfirmed.
function findCardList(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const key of ['cards', 'mainboard', 'spellbook', 'deckCards', 'entries']) {
    if (Array.isArray(obj[key]) && obj[key].length) return obj[key];
  }
  for (const key of Object.keys(obj)) {
    const found = findCardList(obj[key], depth + 1);
    if (found) return found;
  }
  return null;
}

exports.handler = async function (event) {
  const headers = corsHeaders(event);
  const jsonHeaders = Object.assign({ 'Content-Type': 'application/json' }, headers);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const url = (payload.url || '').trim();
  const deckId = extractDeckId(url);
  if (!deckId) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Could not extract a deck ID from that URL' }) };
  }

  const wrapped = { '0': { json: { id: deckId } } };
  const apiUrl = 'https://curiosa.io/api/trpc/deck.getById?batch=1&input=' + encodeURIComponent(JSON.stringify(wrapped));

  try {
    const res = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://curiosa.io',
        'Referer': url,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const text = await res.text();
    console.log('deck.getById status:', res.status);
    console.log('deck.getById raw response:', text.slice(0, 20000));

    if (!res.ok) {
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'Curiosa API returned an error', status: res.status, detail: text.slice(0, 2000) }) };
    }

    let parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'Response was not valid JSON' }) };
    }

    let deckData = null;
    try { deckData = parsed[0].result.data.json; } catch (e) {}
    if (!deckData) {
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'Unrecognized response shape -- see function logs for raw data' }) };
    }

    console.log('deck.getById data keys:', Object.keys(deckData));
    const cardList = findCardList(deckData, 0);

    if (!cardList) {
      console.log('No card list found in deck.getById response -- this procedure likely only returns deck metadata, not contents.');
      return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: 'deck.getById did not include a card list (metadata only) -- see function logs for the full data shape', deckData }) };
    }

    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true, deckName: deckData.name, cards: cardList }) };
  } catch (err) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Failed to reach Curiosa', message: err.message }) };
  }
};
