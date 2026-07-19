// Scrapes a single Curiosa.io deck page for its card list, given a deck URL
// (e.g. https://curiosa.io/decks/cmr0zmkay001f04jrwy07jb6r) passed in via
// the DECK_URL environment variable, and a REQUEST_ID used so the client
// polling for a result knows which response belongs to its own request.
//
// WHY THIS EXISTS: Curiosa deck pages are a Next.js SPA -- confirmed live
// that the deck's title/author/format render server-side, but the actual
// card list does not appear anywhere in the raw HTML; it's populated by
// client-side JS after load. There's also no public deck-lookup API
// (api.sorcerytcg.com is explicitly card-data-only). So getting the real
// card list requires an actual rendered browser, same as the events/rewards
// scrapers.
//
// This runs via workflow_dispatch (manually or triggered from the app's
// Netlify function) rather than on a schedule, since it needs to scrape
// whatever URL the user just pasted in -- not a fixed page. On-demand
// GitHub Actions runs get a much larger execution time budget than a
// Netlify Function would (which is why the triggering function only kicks
// this off rather than doing the scraping itself).
//
// NOTE: this is a best-effort heuristic pass -- I don't have live browser
// access to inspect Curiosa's actual rendered DOM/class names. The
// extraction below tries several common deck-list text patterns and logs
// full diagnostics either way, so if results come back thin or wrong, the
// workflow's logs should make it fast to fix precisely instead of guessing
// again.

const { chromium } = require('playwright');
const fs = require('fs');

const DECK_URL = process.env.DECK_URL;
const REQUEST_ID = process.env.REQUEST_ID || String(Date.now());
const RESULT_FILE = 'deck-import-result.json';

function writeResult(obj) {
  fs.writeFileSync(RESULT_FILE, JSON.stringify(Object.assign({
    requestId: REQUEST_ID,
    url: DECK_URL,
    timestamp: new Date().toISOString()
  }, obj), null, 2));
}

if (!DECK_URL) {
  console.error('No DECK_URL provided.');
  writeResult({ error: 'No deck URL provided.' });
  process.exit(1);
}

// Common deck-list line patterns:
//   "3x Card Name" / "3 x Card Name" / "3 Card Name"  (quantity first)
//   "Card Name x3" / "Card Name (3)"                   (quantity last)
const QTY_FIRST_RE = /^(\d{1,3})\s*[xX]?\s*([A-Z][^%\/]*)$/;
const QTY_LAST_RE = /^(.+?)\s*(?:[xX]\s*(\d{1,3})|\((\d{1,3})\))$/;

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    console.log('Fetching ' + DECK_URL + '...');
    await page.goto(DECK_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000); // let the SPA finish rendering the main card list

    // Confirmed from an earlier diagnostic run of a related scraper:
    // "Collection (10)" and "Maybeboard (23)" appear as bare section
    // headers with NO card lines following them, unlike sections like
    // "Minion (35)" which render their cards immediately. That strongly
    // suggests these sections are collapsed/lazy-loaded and need a click
    // to expand -- try clicking anything whose text matches, for both
    // section names, before reading the final page text. Wrapped
    // defensively since the exact DOM structure is unconfirmed; a failed
    // click here shouldn't crash the whole scrape.
    for (const label of ['Collection', 'Maybeboard']) {
      try {
        const el = page.getByText(label, { exact: false }).first();
        if (await el.count() > 0) {
          console.log('Found an element matching "' + label + '", attempting to click it to expand...');
          await el.click({ timeout: 5000 });
          await page.waitForTimeout(1500); // let any lazy-loaded cards render
          console.log('Clicked "' + label + '".');
        } else {
          console.log('No element found matching "' + label + '" -- skipping.');
        }
      } catch (e) {
        console.log('Could not click "' + label + '" (' + e.message + ') -- continuing without expanding it.');
      }
    }

    const { deckName, lines } = await page.evaluate(() => {
      const h1 = document.querySelector('h1,h2');
      return {
        deckName: h1 ? h1.innerText.trim() : '',
        lines: document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean)
      };
    });

    // The author's Curiosa handle renders as its own "@username" line right
    // after the deck name/title area -- confirmed directly from real
    // diagnostic output (e.g. "Scream!", "@ebelious", "Constructed", ...).
    const authorLine = lines.find(l => /^@[A-Za-z0-9_-]+$/.test(l));
    const author = authorLine ? authorLine.slice(1) : '';

    console.log('Deck name detected: ' + deckName);
    console.log('Author detected: ' + (author || '(none found)'));
    console.log('Full page text (for debugging):', JSON.stringify(lines, null, 2));

    // Deck-builder pages commonly show a composition summary (e.g. "Minion
    // x35", "Site x30") using the exact same "word xN" text shape as a real
    // card line -- exclude these known category/section labels so they
    // don't get mistaken for actual cards.
    const NON_CARD_LABELS = new Set([
      'avatar', 'aura', 'artifact', 'minion', 'magic', 'site', 'spell',
      'collection', 'maybeboard', 'spellbook', 'atlas', 'sideboard',
      'deck', 'cards', 'total', 'unique', 'views', 'comments', 'likes', 'shares'
    ]);

    // Section headers look like "Collection (10)" or "Maybeboard (23)".
    // Confirmed from real diagnostic output that Collection and Maybeboard
    // are genuinely separate zones from the main deck -- Maybeboard in
    // particular commonly repeats cards that are ALSO in the main deck
    // (suggestions/alternates), so its quantities must never be added on
    // top of the main deck's. Cards legitimately appear more than once
    // within the SAME zone's sections too, so dedup/merge is scoped per
    // zone, not globally, and never across zones.
    const SECTION_HEADER_RE = /^[A-Za-z]+\s*\(\d+\)$/;
    function zoneForSection(sectionHeader) {
      const h = sectionHeader.toLowerCase();
      if (h.startsWith('collection')) return 'collection';
      if (h.startsWith('maybeboard')) return 'maybeboard';
      return 'main';
    }
    let currentSection = 'main';
    let currentZone = 'main';
    const seenPerSection = {};

    const cards = []; // each entry: { name, qty, zone }

    lines.forEach(line => {
      if (SECTION_HEADER_RE.test(line)) {
        currentSection = line;
        currentZone = zoneForSection(line);
        return;
      }

      let name = null, qty = null;

      let m = line.match(QTY_FIRST_RE);
      if (m && parseInt(m[1], 10) > 0 && parseInt(m[1], 10) <= 99 && m[2].length > 1) {
        qty = parseInt(m[1], 10);
        name = m[2].trim();
      } else {
        m = line.match(QTY_LAST_RE);
        if (m) {
          name = m[1].trim();
          qty = parseInt(m[2] || m[3], 10);
        }
      }

      if (name && qty && qty > 0 && qty <= 99 && !NON_CARD_LABELS.has(name.toLowerCase())) {
        const key = name.toLowerCase();
        if (!seenPerSection[currentSection]) seenPerSection[currentSection] = new Set();
        if (!seenPerSection[currentSection].has(key)) {
          seenPerSection[currentSection].add(key);
          cards.push({ name, qty, zone: currentZone });
        }
      }
    });

    // Merge same-named entries into one combined quantity, but ONLY within
    // the same zone -- a card repeated across different sections of the
    // main deck still merges together, but a Maybeboard or Collection copy
    // of a card must never add onto the main deck's count (or vice versa).
    function mergeZone(zone) {
      const merged = {};
      const order = [];
      cards.filter(c => c.zone === zone).forEach(c => {
        const key = c.name.toLowerCase();
        if (merged[key]) {
          merged[key].qty += c.qty;
        } else {
          merged[key] = { name: c.name, qty: c.qty };
          order.push(key);
        }
      });
      return order.map(key => merged[key]);
    }

    const finalCards = mergeZone('main');
    const finalCollection = mergeZone('collection');
    const finalMaybeboard = mergeZone('maybeboard');

    console.log('Parsed ' + finalCards.length + ' main deck card(s), ' + finalCollection.length + ' collection card(s), ' + finalMaybeboard.length + ' maybeboard card(s).');

    await browser.close();

    if (!finalCards.length && !finalCollection.length && !finalMaybeboard.length) {
      writeResult({
        error: 'Could not find any card list on that page. It may have failed to load, or the page structure differs from what this scraper expects.',
        deckName,
        author,
        rawTextSample: lines.slice(0, 60)
      });
      process.exit(0);
    }

    writeResult({ deckName, author, cards: finalCards, collection: finalCollection, maybeboard: finalMaybeboard });
    console.log('Done -- wrote ' + finalCards.length + ' main, ' + finalCollection.length + ' collection, ' + finalMaybeboard.length + ' maybeboard card(s) to ' + RESULT_FILE);
  } catch (err) {
    await browser.close().catch(() => {});
    console.error('Scrape failed:', err.message);
    writeResult({ error: 'Failed to load or parse that deck page: ' + err.message });
    process.exit(1);
  }
})();
