// Attempts a FAST path for loading a specific deck's contents: fetches the
// deck page's raw HTML directly and looks for embedded initial data, which
// Next.js apps commonly include server-side (either the older Pages
// Router's `__NEXT_DATA__` script tag, or the newer App Router's streamed
// `self.__next_f.push(...)` chunks). If found, this is a single sub-second
// HTTP request -- dramatically faster than the existing scrape-deck.js /
// GitHub Actions pipeline, which needs a full Playwright browser.
//
// STATUS: experimental / unverified. An earlier plain-text fetch of a deck
// page didn't show the card list, but that was via a tool that strips
// <script> tags during extraction -- it never actually confirmed the data
// isn't embedded, just that it wasn't visible through that specific path.
// This logs the raw HTML (truncated) either way so it can be confirmed or
// ruled out from real evidence. If this doesn't pan out, the app falls
// back to the existing (slower but proven) GitHub Actions pipeline
// automatically -- this is purely additive, not a replacement.
//
// Request body: { "url": "https://curiosa.io/decks/..." }

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

// Tries to find a deck's card list within a parsed Next.js data blob,
// trying several plausible nesting paths since the actual shape is unknown.
function findDeckData(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  if (Array.isArray(obj.cards) || Array.isArray(obj.mainboard) || Array.isArray(obj.spellbook)) return obj;
  for (const key of Object.keys(obj)) {
    const found = findDeckData(obj[key], depth + 1);
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
  if (!/^https:\/\/curiosa\.io\/decks\//.test(url)) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'URL must be a curiosa.io deck link' }) };
  }

  try {
    const res = await fetch(url, { headers: { 'Accept': 'text/html' } });
    const html = await res.text();
    console.log('Deck page fetch status:', res.status);
    console.log('Deck page HTML length:', html.length);

    // Try the classic Pages Router pattern first.
    let deckData = null;
    let source = '';
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      console.log('Found __NEXT_DATA__ script tag, length:', nextDataMatch[1].length);
      try {
        const parsed = JSON.parse(nextDataMatch[1]);
        deckData = findDeckData(parsed, 0);
        source = '__NEXT_DATA__';
      } catch (e) {
        console.log('__NEXT_DATA__ found but failed to parse:', e.message);
      }
    }

    // Fall back to the App Router's streamed self.__next_f.push(...) chunks.
    if (!deckData) {
      const pushMatches = [...html.matchAll(/self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g)];
      console.log('Found ' + pushMatches.length + ' self.__next_f.push(...) chunk(s).');
      for (const m of pushMatches) {
        try {
          const chunkText = JSON.parse('"' + m[1] + '"'); // unescape the JS string
          const jsonStart = chunkText.indexOf('{');
          const jsonStart2 = chunkText.indexOf('[');
          const start = jsonStart === -1 ? jsonStart2 : (jsonStart2 === -1 ? jsonStart : Math.min(jsonStart, jsonStart2));
          if (start === -1) continue;
          const parsed = JSON.parse(chunkText.slice(start));
          const found = findDeckData(parsed, 0);
          if (found) { deckData = found; source = 'next_f chunk'; break; }
        } catch (e) { /* not every chunk is parseable JSON on its own -- expected, keep trying others */ }
      }
    }

    if (!deckData) {
      console.log('No embedded deck data found via either pattern. HTML sample (for debugging):', html.slice(0, 5000));
      return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: 'No embedded deck data found on the page (fast path unavailable for this page structure).' }) };
    }

    console.log('Fast path succeeded via ' + source + '. Deck data keys:', Object.keys(deckData));
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true, source, deckData }) };
  } catch (err) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Failed to fetch deck page', message: err.message }) };
  }
};
