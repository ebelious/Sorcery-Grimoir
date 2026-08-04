// Scrapes a single card's TCGPlayer prices and writes the result into
// Netlify Blobs (read back by get-tcg-price.js). Run by
// scrape-tcg-price.yml, triggered on demand by trigger-tcg-price.js --
// not on a periodic schedule like the other scrapers, since prices are
// only fetched for cards someone's actually looking at.
//
// Why Playwright (not a plain fetch(), unlike enrich-events.js): TCGPlayer
// is a Vue single-page app -- confirmed live via view-source, the raw HTML
// response is just an empty `<div id="app">` shell with no price data at
// all. Everything (including the prices this script needs) is rendered
// client-side by JS after the page loads, so a real browser is required.
//
// Search results page structure (confirmed live via browser inspection --
// this is what a rendered page actually contains, which view-source never
// shows for this site):
//   <section class="product-card__product">
//     ...
//     <span class="product-card__title truncate">Card Name</span>       <- exact match target
//                                                                          (foil variants append " (Foil)" to this
//                                                                          same field -- no separate class/flag)
//     <span class="inventory__price-with-shipping">$6.28</span>        <- lowest current listing, with shipping
//     <span class="product-card__market-price--value">$6.44</span>     <- TCGPlayer's own Market Price
//   </section>
//
// Matching a card to the correct tile: compares each tile's title against
// CARD_NAME with an exact (trimmed, case-insensitive) match. This
// naturally excludes foil tiles for a non-foil request and vice versa,
// since "Card Name" !== "Card Name (Foil)" -- no separate foil-detection
// logic needed beyond the exact-match itself.

const { chromium } = require('playwright');
const { getStore } = require('@netlify/blobs');

const CARD_NAME = (process.env.CARD_NAME || '').trim();
const SEARCH_URL = 'https://www.tcgplayer.com/search/sorcery-contested-realm/product?q=' + encodeURIComponent(CARD_NAME) + '&view=grid';

function keyFor(name) {
  return name.trim().toLowerCase();
}

function parsePrice(text) {
  if (!text) return null;
  const n = parseFloat(text.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

async function main() {
  if (!CARD_NAME) {
    console.error('No CARD_NAME provided.');
    process.exit(1);
  }

  const store = (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_API_TOKEN)
    ? getStore({ name: 'sg-tcg-prices', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN })
    : getStore('sg-tcg-prices');

  const key = keyFor(CARD_NAME);
  let result;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    });

    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // The results are rendered client-side after the page's own JS runs --
    // wait for at least one result tile, rather than a fixed sleep, so
    // this doesn't race a slow render on a cold TCGPlayer page load.
    await page.waitForSelector('.product-card__product', { timeout: 20000 }).catch(() => {});

    const tiles = await page.$$eval('.product-card__product', (nodes) => {
      return nodes.map((el) => {
        const titleEl = el.querySelector('.product-card__title');
        const listingEl = el.querySelector('.inventory__price-with-shipping');
        const marketEl = el.querySelector('.product-card__market-price--value');
        return {
          title: titleEl ? titleEl.textContent.trim() : '',
          listingText: listingEl ? listingEl.textContent.trim() : '',
          marketText: marketEl ? marketEl.textContent.trim() : ''
        };
      });
    });

    const targetLower = CARD_NAME.toLowerCase();
    const match = tiles.find((t) => t.title.toLowerCase() === targetLower);

    if (match) {
      result = {
        name: CARD_NAME,
        marketPrice: parsePrice(match.marketText),
        marketPriceText: match.marketText || null,
        listingPrice: parsePrice(match.listingText),
        listingPriceText: match.listingText || null,
        found: true,
        updatedAt: Date.now()
      };
      console.log('Found price for "' + CARD_NAME + '": market=' + match.marketText + ' listing=' + match.listingText);
    } else {
      result = {
        name: CARD_NAME,
        marketPrice: null,
        marketPriceText: null,
        listingPrice: null,
        listingPriceText: null,
        found: false,
        updatedAt: Date.now()
      };
      console.log('No exact-match tile found for "' + CARD_NAME + '" (' + tiles.length + ' tile(s) on the page).');
    }
  } catch (e) {
    console.error('Scrape failed:', e.message);
    result = {
      name: CARD_NAME,
      marketPrice: null,
      marketPriceText: null,
      listingPrice: null,
      listingPriceText: null,
      found: false,
      error: e.message,
      updatedAt: Date.now()
    };
  } finally {
    await browser.close();
  }

  await store.setJSON(key, result);
  // Always clear the pending marker, success or failure, so a future
  // trigger isn't blocked waiting out the full debounce window for
  // nothing -- the window in trigger-tcg-price.js is really just a safety
  // net for the (hopefully rare) case this step itself doesn't run.
  await store.delete('pending:' + key).catch(() => {});

  console.log('Wrote result to Blobs under key "' + key + '".');
}

main().catch((e) => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
