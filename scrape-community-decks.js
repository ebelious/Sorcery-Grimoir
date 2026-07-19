// Scrapes the Curiosa.io community decks listing for deck metadata --
// name, author, URL, element(s), avatar, format, timestamp, views -- so the
// app can show a browsable, filterable "Community Decks" list without
// needing to fully scrape every single deck's card list up front (that
// happens on-demand instead, via the existing import-deck.yml pipeline,
// only for whichever specific deck someone actually opens).
//
// APPROACH (v2): the user found that Curiosa's own filter UI encodes its
// state as base64 JSON in the URL, e.g. decoded:
//   {"query":"","set":"*","filters":[{"label":"Fire","value":"Fire","type":"element"}],
//    "csort":"name","dsort":"latest","fsort":"latest","divider":"all","avatar":"*"}
// This matches the shape of a tRPC batch request seen earlier hitting
// curiosa.io/api/trpc/deck.search -- meaning the site's own frontend is
// just calling that API directly with this filter object. Rather than
// scrape the rendered page and guess at which images represent which
// element/avatar (fragile, confirmed unreliable), this now tries calling
// that same API directly, from inside a real page context so it inherits
// whatever cookies/session Curiosa's frontend normally has -- which a
// same-origin API like this may expect.
//
// NOTE: the RESPONSE shape from this API has never been seen directly
// (only the request shape, via the user's decoded URL). This guesses at
// the standard tRPC batch-response envelope and unwraps several plausible
// paths to the actual deck array, but logs the complete raw response
// either way. If the API approach fails or doesn't yield decks, this
// automatically falls back to the previous DOM/image-scraping approach
// (kept below, unchanged) so a run never comes back completely empty.

const { chromium } = require('playwright');
const fs = require('fs');

const DECKS_URL = 'https://curiosa.io/decks';
const MAX_DECKS = 60;

const API_FILTER = {
  query: '', set: '*', filters: [],
  csort: 'views', dsort: 'views', fsort: 'views',
  divider: 'all', avatar: '*', limit: MAX_DECKS
};

function buildApiUrl(filterObj) {
  const wrapped = { '0': { json: filterObj } };
  return 'https://curiosa.io/api/trpc/deck.search?batch=1&input=' + encodeURIComponent(JSON.stringify(wrapped));
}

// Parses relative-time strings ("4 hours ago", "a few seconds ago") into
// an approximate timestamp, for "Latest" sorting -- used by both the API
// path (in case timestamps come back as relative strings) and the DOM
// fallback path.
const NOW = Date.now();
const UNIT_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 };
function parseRelativeTime(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(/^(a|an|\d+)\s*(?:few\s+)?(second|minute|hour|day|week|month|year)s?\s+ago$/i);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : 1;
  const unitMs = UNIT_MS[m[2].toLowerCase()] || 0;
  return NOW - n * unitMs;
}

// Tries several plausible paths to the actual deck array within a tRPC
// batch response envelope. Returns null if none of them look right.
function extractDecksFromApiResponse(data) {
  const candidates = [];
  try { candidates.push(data[0].result.data.json.decks); } catch (e) {}
  try { candidates.push(data[0].result.data.json); } catch (e) {}
  try { candidates.push(data[0].result.data); } catch (e) {}
  try { candidates.push(data.result.data.json.decks); } catch (e) {}
  try { candidates.push(data.decks); } catch (e) {}
  return candidates.find(c => Array.isArray(c) && c.length) || null;
}

// Normalizes one deck record from the API into this scraper's output
// shape. Field names here are best-effort guesses (id/slug, name/title,
// author/username/user.name, elements/threshold, avatar/avatarName) --
// logged raw either way so these can be corrected precisely from a real
// response instead of guessing blind.
function normalizeApiDeck(d) {
  const id = d.id || d.slug || d.deckId || '';
  const url = id ? ('https://curiosa.io/decks/' + id) : (d.url || '');
  const name = d.name || d.title || d.deckName || 'Untitled Deck';
  const author = (d.author && (d.author.username || d.author.name)) || d.username || d.authorName || '';
  let elements = [];
  if (Array.isArray(d.elements)) elements = d.elements;
  else if (Array.isArray(d.threshold)) elements = d.threshold;
  else if (typeof d.element === 'string') elements = [d.element];
  elements = elements.map(e => String(e).toLowerCase()).filter(e => ['earth', 'fire', 'water', 'air'].includes(e));
  const avatar = (d.avatar && (d.avatar.name || d.avatar)) || d.avatarName || '';
  const format = d.format || d.divider || '';
  const views = typeof d.views === 'number' ? d.views : (typeof d.viewCount === 'number' ? d.viewCount : null);
  let timestamp = null;
  if (typeof d.updatedAt === 'string' || typeof d.updatedAt === 'number') timestamp = new Date(d.updatedAt).getTime() || null;
  else if (typeof d.updated === 'string') timestamp = parseRelativeTime(d.updated) || new Date(d.updated).getTime() || null;
  return { name, author, url, format, timestamp, views, elements, avatar: typeof avatar === 'string' ? avatar : '' };
}

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let decks = [];

  try {
    console.log('Loading ' + DECKS_URL + ' first (to establish a normal session)...');
    await page.goto(DECKS_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    const apiUrl = buildApiUrl(API_FILTER);
    console.log('Trying Curiosa\'s internal API directly: ' + apiUrl);

    const apiResult = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
      } catch (e) {
        return { ok: false, status: 0, text: '', error: e.message };
      }
    }, apiUrl);

    console.log('API response status: ' + apiResult.status + (apiResult.ok ? ' (ok)' : ' (not ok)'));
    console.log('Full raw API response (for debugging):', apiResult.text.slice(0, 20000));

    if (apiResult.ok && apiResult.text) {
      try {
        const parsed = JSON.parse(apiResult.text);
        const rawDecks = extractDecksFromApiResponse(parsed);
        if (rawDecks) {
          console.log('API path succeeded -- found ' + rawDecks.length + ' deck(s) in the response.');
          console.log('First raw deck record shape (for debugging):', JSON.stringify(rawDecks[0], null, 2));
          decks = rawDecks.map(normalizeApiDeck).filter(d => d.url);
        } else {
          console.log('API response parsed but no recognizable deck array found in it -- see raw response above. Falling back to DOM scraping.');
        }
      } catch (e) {
        console.log('API response was not valid JSON (' + e.message + ') -- falling back to DOM scraping.');
      }
    } else {
      console.log('API call did not succeed -- falling back to DOM scraping.');
    }

    // Fallback: the original DOM/image-heuristic approach, unchanged, used
    // automatically if the API path above didn't yield anything.
    if (!decks.length) {
      console.log('Running DOM-scraping fallback...');
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(600);
      }

      const raw = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href^="/decks/"]'));
        return anchors.map(a => ({
          href: a.getAttribute('href'),
          text: a.innerText.trim(),
          images: Array.from(a.querySelectorAll('img')).map(img => ({
            src: img.getAttribute('src') || '',
            alt: img.getAttribute('alt') || ''
          }))
        })).filter(a => a.href && a.href !== '/decks' && a.text);
      });

      console.log('Found ' + raw.length + ' raw deck anchor(s) (before dedup).');
      console.log('Full raw anchor data (for debugging):', JSON.stringify(raw, null, 2));

      const ELEMENTS = ['earth', 'fire', 'water', 'air'];
      function detectElements(images) {
        const found = new Set();
        images.forEach(img => {
          const hay = (img.alt + ' ' + img.src).toLowerCase();
          ELEMENTS.forEach(el => { if (hay.includes(el)) found.add(el); });
        });
        return Array.from(found);
      }
      function detectAvatar(images) {
        const avatarImg = images.find(img => /avatar/i.test(img.alt) || /avatar/i.test(img.src));
        if (avatarImg && avatarImg.alt) return avatarImg.alt.replace(/avatar/i, '').trim() || avatarImg.alt;
        return '';
      }

      const seen = new Set();
      raw.forEach(item => {
        if (seen.has(item.href)) return;
        seen.add(item.href);

        const lines = item.text.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return;

        const KNOWN_BADGES = new Set(['new', 'primer']);
        const KNOWN_FORMATS = new Set(['constructed', 'multiplayer', 'draft', 'jumpstart', 'limited']);

        let name = null, timestamp = null, views = null, format = '';
        for (const line of lines) {
          const lw = line.toLowerCase();
          if (KNOWN_BADGES.has(lw)) continue;
          const rel = parseRelativeTime(line);
          if (rel != null) { timestamp = rel; continue; }
          if (/^\d+$/.test(line)) { if (views == null) views = parseInt(line, 10); continue; }
          if (KNOWN_FORMATS.has(lw)) { format = line; continue; }
          if (line.startsWith('@')) continue;
          if (name == null) name = line;
        }
        if (!name) name = lines[0];

        const authorLine = lines.find(l => l.startsWith('@')) || lines.find(l => /^by\s+/i.test(l));
        const author = authorLine ? authorLine.replace(/^by\s+/i, '').replace(/^@/, '') : '';

        decks.push({
          name, author, url: 'https://curiosa.io' + item.href,
          format, timestamp, views,
          elements: detectElements(item.images),
          avatar: detectAvatar(item.images)
        });
      });
    }

    await browser.close();

    console.log('Parsed ' + decks.length + ' unique deck(s) total.');

    if (!decks.length) {
      fs.writeFileSync('community-decks.json', JSON.stringify({ updated: new Date().toISOString(), decks: [] }, null, 2));
      console.error('No decks found via either the API or DOM fallback -- see diagnostics above.');
      process.exit(1);
    }

    const output = {
      updated: new Date().toISOString(),
      source: DECKS_URL,
      decks: decks.slice(0, MAX_DECKS)
    };

    fs.writeFileSync('community-decks.json', JSON.stringify(output, null, 2));
    console.log('Done -- wrote ' + output.decks.length + ' decks to community-decks.json');
  } catch (err) {
    await browser.close().catch(() => {});
    console.error('Scrape failed:', err.message);
    fs.writeFileSync('community-decks.json', JSON.stringify({ updated: new Date().toISOString(), decks: [], error: err.message }, null, 2));
    process.exit(1);
  }
})();
