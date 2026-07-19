// Searches Curiosa's internal deck.search API server-side and returns the
// result to the client. This replaces routing the request through a public
// CORS proxy (corsproxy.io, allorigins.win) -- confirmed via a real error
// log that corsproxy.io's free tier only allows requests from a specific
// origin allowlist (localhost, various sandboxed dev environments,
// github.io) which does NOT include netlify.app, causing every search from
// this app's Netlify-hosted copy to fail outright regardless of browser.
// CORS is a browser-enforced restriction; it doesn't apply to this
// server-side fetch at all, so this sidesteps the entire problem rather
// than depending on a third-party proxy's availability/allowlist.
//
// Request body: { "query": "scream" }
// Response body: whatever Curiosa's API returns, passed through as-is
// (still logged raw either way, since the actual response shape from this
// API has never been directly confirmed).

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

  const query = (payload.query || '').trim();
  if (!query) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Missing query' }) };
  }

  const filterObj = {
    query, set: '*', filters: [],
    csort: 'relevance', dsort: 'relevance', fsort: 'relevance',
    divider: 'all', avatar: '*'
  };
  const wrapped = { '0': { json: filterObj } };
  const apiUrl = 'https://curiosa.io/api/trpc/deck.search?batch=1&input=' + encodeURIComponent(JSON.stringify(wrapped));

  try {
    const res = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://curiosa.io',
        'Referer': 'https://curiosa.io/decks',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const text = await res.text();
    console.log('Curiosa deck search status:', res.status);
    console.log('Curiosa deck search raw response:', text.slice(0, 20000));

    if (!res.ok) {
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'Curiosa API returned an error', status: res.status, detail: text.slice(0, 2000) }) };
    }

    // Pass the raw response straight through -- the client does its own
    // best-effort extraction, same as the (now-removed) client-proxy path.
    return { statusCode: 200, headers: jsonHeaders, body: text };
  } catch (err) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Failed to reach Curiosa', message: err.message }) };
  }
};
