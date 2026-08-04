// Reads a single card's cached TCGPlayer price from Netlify Blobs.
// Written by scrape-tcg-price.js (run via GitHub Actions, triggered by
// trigger-tcg-price.js) -- this function only ever reads, never triggers a
// scrape itself, so it's fast and safe to call every time a card's detail
// popup opens.
//
// GET ?name=<card name>
//   -> 200 { name, marketPrice, listingPrice, updatedAt }
//   -> 404 { error: 'No cached price yet.' }  (never scraped, or the scrape found no match)

const { getStore } = require('@netlify/blobs');

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
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const params = event.queryStringParameters || {};
  const name = (params.name || '').trim().slice(0, 120);
  if (!name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing card name' }) };
  }

  const store = (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN)
    ? getStore({ name: 'sg-tcg-prices', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN })
    : getStore('sg-tcg-prices');

  try {
    const data = await store.get(keyFor(name), { type: 'json' });
    if (!data) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No cached price yet.' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to read cache', message: err.message }) };
  }
};
