// Fetches deck-import-result.json via GitHub's REST API (authenticated,
// same GITHUB_TOKEN already configured for trigger-deck-import.js) instead
// of raw.githubusercontent.com. This exists specifically to work around a
// documented GitHub limitation: raw.githubusercontent.com is served
// through a CDN with a default ~5 minute cache, confirmed by GitHub's own
// engineers on their community forum -- meaning a freshly-pushed result
// can take several minutes to actually become visible at that URL, no
// matter what cache-busting query string is appended. The REST API isn't
// subject to that same CDN caching layer.
//
// Unauthenticated GitHub API calls are capped at 60/hour, which polling
// every 5 seconds would blow through in minutes -- routing through this
// authenticated server-side function raises that to 5,000/hour.
//
// Response: whatever is in deck-import-result.json, decoded and passed
// through as-is. Returns 404 if the file doesn't exist yet (e.g. between
// the branch's creation and its first commit).

const GITHUB_OWNER = 'ebelious';
const GITHUB_REPO = 'Sorcery-Grimoir';
const RESULT_PATH = 'deck-import-result.json';
const RESULT_BRANCH = 'deck-results';

const ALLOWED_ORIGINS = [
  'https://ebelious.github.io',
  'https://elaborate-mooncake-835943.netlify.app'
];

function corsHeaders(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

exports.handler = async function (event) {
  const headers = corsHeaders(event);
  const jsonHeaders = Object.assign({ 'Content-Type': 'application/json' }, headers);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Server is not configured (missing GITHUB_TOKEN)' }) };
  }

  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${RESULT_PATH}?ref=${RESULT_BRANCH}`;
    const res = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (res.status === 404) {
      return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: 'Result file not found yet' }) };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'GitHub API rejected the request', status: res.status, detail: text.slice(0, 500) }) };
    }

    const data = await res.json();
    // GitHub's contents API returns the file base64-encoded (sometimes
    // with embedded newlines in the base64 string, which Buffer handles
    // fine either way).
    const decoded = Buffer.from(data.content, 'base64').toString('utf8');

    return { statusCode: 200, headers: jsonHeaders, body: decoded };
  } catch (err) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Failed to reach GitHub', message: err.message }) };
  }
};
