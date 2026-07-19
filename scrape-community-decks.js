// Scrapes the Curiosa.io community decks listing (https://curiosa.io/decks)
// for deck metadata -- name, author, and URL -- so the app can show a
// browsable "Community Decks" list without needing to fully scrape every
// single deck's card list up front (that happens on-demand instead, via
// the existing import-deck.yml pipeline, only for whichever specific deck
// someone actually opens).
//
// WHY THIS EXISTS: same reasoning as the other Curiosa scrapers in this
// repo -- the listing page is a Next.js SPA and confirmed (via a plain
// fetch, live) to render its actual deck cards client-side; nothing useful
// is in the raw HTML. Needs a real rendered browser, same as
// scrape-deck.js.
//
// APPROACH: unlike scrape-deck.js (which parses innerText line-by-line,
// since a card list has no natural anchor tags to key off of), each deck
// tile on the LISTING page almost certainly links to its own deck page
// (href starting with /decks/) -- so this scrapes anchor elements
// directly, pulling both the href (the one thing pure text extraction
// can't give us, and the one thing we absolutely need for later on-demand
// fetching) and that anchor's own text content, then applies lightweight
// heuristics to split the text into a deck name vs. author.
//
// NOTE: best-effort heuristic pass -- no live browser access to verify the
// actual DOM structure. Full diagnostics are logged either way so this can
// be corrected precisely from a real run's output, same as every other
// scraper in this repo.

const { chromium } = require('playwright');
const fs = require('fs');

const DECKS_URL = 'https://curiosa.io/decks';
const MAX_DECKS = 60;

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    console.log('Fetching ' + DECKS_URL + '...');
    await page.goto(DECKS_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000); // let the SPA finish rendering the deck list

    // Scroll a few times in case the list is lazy-loaded/paginated on scroll
    // (same technique used successfully in scrape-rewards.js).
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(600);
    }

    const raw = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href^="/decks/"]'));
      return anchors.map(a => ({
        href: a.getAttribute('href'),
        text: a.innerText.trim()
      })).filter(a => a.href && a.href !== '/decks' && a.text);
    });

    console.log('Found ' + raw.length + ' raw deck anchor(s) (before dedup).');
    console.log('Full raw anchor data (for debugging):', JSON.stringify(raw, null, 2));

    const seen = new Set();
    const decks = [];

    raw.forEach(item => {
      if (seen.has(item.href)) return;
      seen.add(item.href);

      const lines = item.text.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) return;

      // The real diagnostic data shows each tile's text has several
      // optional lines before/after the actual deck name: a badge ("New",
      // "Primer"), a relative timestamp ("4 hours ago"), one or more bare
      // view/like/comment counts, a format name, and finally "@author".
      // Skip all of those and take the first genuinely-remaining line as
      // the deck name.
      const KNOWN_BADGES = new Set(['new', 'primer']);
      const KNOWN_FORMATS = new Set(['constructed', 'multiplayer', 'draft', 'jumpstart', 'limited']);

      let name = null;
      for (const line of lines) {
        const lw = line.toLowerCase();
        if (KNOWN_BADGES.has(lw)) continue;
        if (/\bago$/i.test(line)) continue;
        if (/^\d+$/.test(line)) continue;
        if (KNOWN_FORMATS.has(lw)) continue;
        if (line.startsWith('@')) continue;
        name = line;
        break;
      }
      if (!name) name = lines[0]; // fallback if every line got filtered out somehow

      const authorLine = lines.find(l => l.startsWith('@')) || lines.find(l => /^by\s+/i.test(l));
      const author = authorLine ? authorLine.replace(/^by\s+/i, '').replace(/^@/, '') : '';

      decks.push({
        name,
        author,
        url: 'https://curiosa.io' + item.href
      });
    });

    await browser.close();

    console.log('Parsed ' + decks.length + ' unique deck(s).');

    if (!decks.length) {
      fs.writeFileSync('community-decks.json', JSON.stringify({ updated: new Date().toISOString(), decks: [] }, null, 2));
      console.error('No decks found -- page may not have rendered correctly, or the anchor structure differs from what this scraper expects. See diagnostics above.');
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
