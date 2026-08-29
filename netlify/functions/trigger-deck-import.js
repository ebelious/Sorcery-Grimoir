// Triggers the "Import Deck from URL" GitHub Actions workflow with a
// user-supplied deck URL, then returns immediately. This function does NOT
// do the scraping itself -- it just kicks off scrape-deck.js on GitHub's
// infrastructure, which has a much larger execution time budget than a
// Netlify Function does (Netlify: ~10s free tier, ~26s paid; a headless
// browser loading a JS-heavy SPA page can eat into that fast). The client
// polls deck-import-result.json (written by the workflow) for the result.
//
// Setup required in the Netlify dashboard (Site settings → Environment
// variables):
//   GITHUB_TOKEN — a GitHub Personal Access Token with the "workflow"
//     scope (Settings → Developer settings → Personal access tokens →
//     Fine-grained tokens, with Actions: Read and write permission on this
//     repo, or a classic token with the "workflow" scope).
//
// Request body: { "url": "https://sorcerytcg.com/decks/...", "requestId": "..." }

const ALLOWED_ORIGINS = [
  'https://ebelious.github.io',
  'https://elaborate-mooncake-835943.netlify.app'
];

const GITHUB_OWNER = 'ebelious';
const GITHUB_REPO = 'Sorcery-Grimoir';
const WORKFLOW_FILE = 'import-deck.yml';

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

exports.handler = async function (event) {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  let url = (payload.url || '').trim();   /* reassigned below when an old link is rewritten */
  const requestId = (payload.requestId || String(Date.now())).trim();

  if (!url) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing deck url' }) };
  }
  /* Both hosts, and the old one is rewritten rather than merely tolerated.
     Decks live on sorcerytcg.com now and the host this used to insist on is gone, so a
     link from the current site was refused outright while the only link it accepted could
     no longer be fetched -- the gate rejected everything that works and admitted only what
     does not.
     Old links are still admitted, because they are all over people's notes, but they are
     rewritten before anything is done with them since following them would fail.
     Still an exact-shape check against named hosts: that is what stops this being pointed
     at an arbitrary address, so it stays a list rather than becoming a looser pattern. */
  if (!/^https:\/\/(www\.)?(sorcerytcg\.com|curiosa\.io)\/decks\//.test(url)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'URL must be a Sorcery deck link (https://sorcerytcg.com/decks/...)' }) };
  }
  url = url.replace(/^https:\/\/(www\.)?curiosa\.io/, 'https://sorcerytcg.com');

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server is not configured (missing GITHUB_TOKEN)' }) };
  }

  try {
    const ghResponse = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { deck_url: url, request_id: requestId }
        })
      }
    );

    if (!ghResponse.ok) {
      const text = await ghResponse.text().catch(() => '');
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'GitHub API rejected the request', status: ghResponse.status, detail: text }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, requestId }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to trigger workflow', message: err.message }) };
  }
};
