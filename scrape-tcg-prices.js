// Scrapes TCGPlayer market + listing prices for EVERY card in cards.json,
// on a periodic 2-hour schedule (scrape-tcg-prices.yml) rather than
// on-demand. Supersedes the earlier on-demand design
// (trigger-tcg-price.js/get-tcg-price.js/scrape-tcg-price.js, keyed on a
// single card at a time) -- those can be removed/left undeployed.
//
// Why Playwright (not a plain fetch(), unlike enrich-events.js): TCGPlayer
// is a Vue single-page app -- confirmed live via view-source, the raw HTML
// response is just an empty `<div id="app">` shell with no price data at
// all. Everything is rendered client-side by JS after the page loads, so a
// real browser is required.
//
// Output: tcg-prices.json, a flat map keyed by lowercased card name,
// committed to the repo -- same convention as cards.json/events.json/
// discord.json, fetched directly by the client with no Netlify Function
// involved for reads. This also sidesteps the CORS restriction the earlier
// Netlify-Function-based design had when tested from a non-whitelisted
// origin (e.g. a local file) -- a same-origin static JSON fetch has no
// such restriction.
//
// Search results page structure (confirmed live via browser inspection --
// this is what a rendered page actually contains, which view-source never
// shows for this SPA):
//   <section class="product-card__product">
//     <span class="product-card__title truncate">Card Name</span>       <- exact match target
//                                                                          (foil variants append " (Foil)" to this
//                                                                          same field -- no separate class/flag)
//     <span class="inventory__price-with-shipping">$6.28</span>        <- lowest current listing, with shipping
//     <span class="product-card__market-price--value">$6.44</span>     <- TCGPlayer's own Market Price
//   </section>
// Matching a card to the correct tile: exact (trimmed, case-insensitive)
// title match against the card's name for the NON-FOIL price, and an exact
// match against "<name> (Foil)" for the FOIL price. Because foil tiles are
// a distinct search result whose title is just the name plus " (Foil)",
// both are captured from the same results page in one navigation.
//
// Output shape per card (foil block only present when a foil tile exists):
//   {
//     name, marketPrice, marketPriceText, listingPrice, listingPriceText,
//     found, updatedAt,
//     foil: { marketPrice, marketPriceText, listingPrice, listingPriceText, found }
//   }
//
// SCALE WARNING: this is a much bigger scrape than any other script in
// this repo -- one full page navigation PER CARD (1000+), not a handful of
// API calls. A single browser/page is reused across all cards (not
// relaunched per card) to keep this tractable, with a short delay between
// each card's search to go easier on TCGPlayer's bot detection than
// hammering it as fast as possible would. Even so, a run of this size is
// inherently more likely to eventually get rate-limited or blocked than
// any of the other scrapers here, which only make a handful of requests.
// If that happens mid-run, whatever cards were already scraped are still
// merged into the existing tcg-prices.json (a card's last known price is
// kept until a future run actually replaces it) rather than the whole
// run's progress being discarded.

const fs = require('fs');
const { chromium } = require('playwright');

const CARDS_FILE = 'cards.json';
const OUT_FILE = 'tcg-prices.json';
const DELAY_MS = 1200;       // pause between each card's search
const NAV_TIMEOUT_MS = 30000;
const RESULT_TIMEOUT_MS = 15000;

function keyFor(name) {
  return name.trim().toLowerCase();
}

function parsePrice(text) {
  if (!text) return null;
  const n = parseFloat(text.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Build the price object for a single matched tile (or a "not found" shell).
function priceFromTile(tile) {
  if (!tile) {
    return { marketPrice: null, marketPriceText: null, listingPrice: null, listingPriceText: null, found: false };
  }
  return {
    marketPrice: parsePrice(tile.marketText),
    marketPriceText: tile.marketText || null,
    listingPrice: parsePrice(tile.listingText),
    listingPriceText: tile.listingText || null,
    found: true
  };
}

async function scrapeOne(page, cardName) {
  const url = 'https://www.tcgplayer.com/search/sorcery-contested-realm/product?q=' + encodeURIComponent(cardName) + '&view=grid';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('.product-card__product', { timeout: RESULT_TIMEOUT_MS }).catch(() => {});

  const tiles = await page.$$eval('.product-card__product', (nodes) =>
    nodes.map((el) => {
      const titleEl = el.querySelector('.product-card__title');
      const listingEl = el.querySelector('.inventory__price-with-shipping');
      const marketEl = el.querySelector('.product-card__market-price--value');
      return {
        title: titleEl ? titleEl.textContent.trim() : '',
        listingText: listingEl ? listingEl.textContent.trim() : '',
        marketText: marketEl ? marketEl.textContent.trim() : ''
      };
    })
  );

  const targetLower = cardName.toLowerCase();
  const foilLower = (cardName + ' (Foil)').toLowerCase();

  // Non-foil tile: exact title match (this naturally excludes the foil tile,
  // whose title ends in " (Foil)"). Foil tile: exact "<name> (Foil)" match.
  const match = tiles.find((t) => t.title.toLowerCase() === targetLower);
  const foilMatch = tiles.find((t) => t.title.toLowerCase() === foilLower);

  const base = priceFromTile(match);
  const result = {
    name: cardName,
    marketPrice: base.marketPrice,
    marketPriceText: base.marketPriceText,
    listingPrice: base.listingPrice,
    listingPriceText: base.listingPriceText,
    found: base.found,
    updatedAt: Date.now()
  };

  // Only attach a foil block when a foil tile actually exists, so the client
  // can show a "Foil" line for cards that have foils and omit it otherwise.
  if (foilMatch) {
    result.foil = priceFromTile(foilMatch);
  }

  return result;
}

async function main() {
  if (!fs.existsSync(CARDS_FILE)) {
    console.error('cards.json not found -- nothing to scrape.');
    process.exit(1);
  }
  const cardsData = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
  const cards = Array.isArray(cardsData.cards) ? cardsData.cards : [];
  if (!cards.length) {
    console.error('cards.json has no cards -- nothing to scrape.');
    process.exit(1);
  }

  // Merge into whatever's already there -- a card this run fails to reach
  // (error, or the run gets cut off) keeps its last known price instead of
  // losing it.
  let results = {};
  if (fs.existsSync(OUT_FILE)) {
    try {
      results = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) || {};
    } catch (e) {
      console.warn('Could not parse existing tcg-prices.json, starting fresh:', e.message);
    }
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  });

  let found = 0, notFound = 0, failed = 0, foilFound = 0;
  for (let i = 0; i < cards.length; i++) {
    const name = cards[i].n;
    if (!name) continue;
    try {
      const result = await scrapeOne(page, name);
      results[keyFor(name)] = result;
      if (result.found) found++; else notFound++;
      if (result.foil && result.foil.found) foilFound++;
    } catch (e) {
      console.warn('Failed to scrape "' + name + '":', e.message);
      failed++;
      // Deliberately not writing anything for this card -- whatever was
      // already in `results` for it (from a previous run) is left as-is.
    }
    if (i % 25 === 0) console.log('Progress: ' + (i + 1) + '/' + cards.length + ' (found=' + found + ' foil=' + foilFound + ' notFound=' + notFound + ' failed=' + failed + ')');
    await sleep(DELAY_MS);
  }

  await browser.close();

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log('Done. ' + found + ' found (' + foilFound + ' with foil), ' + notFound + ' not found on TCGPlayer, ' + failed + ' failed, ' + cards.length + ' total cards. Wrote ' + OUT_FILE + '.');
}

main().catch((e) => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
