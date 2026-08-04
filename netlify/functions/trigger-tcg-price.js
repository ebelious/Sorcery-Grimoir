// Triggers the "Scrape TCGPlayer Price" GitHub Actions workflow for a
// single card, then returns immediately. Mirrors trigger-deck-import.js's
// architecture exactly and for the same reason: Playwright (needed because
// TCGPlayer's price is only rendered client-side by their own JS -- a
// plain fetch() just returns an empty Vue app shell) can't run inside a
// Netlify Function reliably. GitHub Actions has a much larger execution
// budget, so the actual scrape happens there; this function just kicks it
// off. Unlike deck import (a one-shot "give me this one deck's contents"
// action), this is a persistent, ever-growing cache keyed by card name --
// so the workflow writes its result into Netlify Blobs (get-tcg-price.js
// reads it back) rather than committing a result file to a branch.
//
// Debounce: this is called every time a card's detail popup opens, which
// could be very frequent (browsing lots of cards, or reopening the same
// one repeatedly). Without a guard, that would spam GitHub Actions with a
// workflow run per popup-open. Before dispatching, this checks the cached
// entry's own timestamp (skip if refreshed within FRESH_WINDOW_MS) and a
// separate "pending" marker (skip if a scrape for this card was already
// kicked off within PENDING_WINDOW_MS and hasn't had time to finish yet).
//
// Setup required in the Netlify dashboard (Site settings → Environment
// variables), in addition to what trigger-deck-import.js already needs:
//   GITHUB_TOKEN — same token already configured for deck import (needs
//     Actions: Read and write on this repo).
//   NETLIFY_SITE_ID / NETLIFY_API_TOKEN — same as match-sync.js/
//     share-deck.js's own fallback already uses, so the pending-marker
//     write below works the same way in this environment.
//
// Request body: { "name": "<exact card name>" }

const { getStore } = require('@netlify/blobs');

const ALLOWED_ORIGINS = [
  'https://ebelious.github.io',
  'https://elaborate-mooncake-835943.netlify.app'
];

const GITHUB_OWNER = 'ebelious';
const GITHUB_REPO = 'Sorcery-Grimoir';
const WORKFLOW_FILE = 'scrape-tcg-price.yml';

const FRESH_WINDOW_MS = 5 * 60 * 1000;    // don't re-scrape a price fetched within the last 5 minutes
const PENDING_WINDOW_MS = 3 * 60 * 1000;  // don't double-trigger a scrape that's already in flight

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

function keyFor(name) {
  return name.trim().toLowerCase();
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

  const name = (payload.name || '').trim().slice(0, 120);
  if (!name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing card name' }) };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server is not configured (missing GITHUB_TOKEN)' }) };
  }

  const store = (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN)
    ? getStore({ name: 'sg-tcg-prices', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN })
    : getStore('sg-tcg-prices');

  const key = keyFor(name);

  try {
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    if (existing && existing.updatedAt && (Date.now() - existing.updatedAt) < FRESH_WINDOW_MS) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'fresh' }) };
    }

    const pending = await store.get('pending:' + key, { type: 'json' }).catch(() => null);
    if (pending && pending.at && (Date.now() - pending.at) < PENDING_WINDOW_MS) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'pending' }) };
    }

    await store.setJSON('pending:' + key, { at: Date.now() });

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
          inputs: { card_name: name }
        })
      }
    );

    if (!ghResponse.ok) {
      const text = await ghResponse.text().catch(() => '');
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'GitHub API rejected the request', status: ghResponse.status, detail: text }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to trigger workflow', message: err.message }) };
  }
};
