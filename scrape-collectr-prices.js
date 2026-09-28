// Collectr market prices for every card in cards.json -> collectr-prices.json.
//
// Through a REAL browser (Playwright Chromium), not fetch(): Collectr's API is behind
// CloudFront's bot control, which fingerprints the TLS handshake itself -- a Node fetch is
// refused (403) however browser-like its headers are. So the page app.getcollectr.com is
// opened in Chromium, and every API call is made FROM that page (page.evaluate + fetch),
// exactly as the app makes them: same origin, same handshake, same everything.
//
// Per card:  /catalog/suggestions?username=<anon>&searchString=<name>&offset=0&limit=10
//            -> products "Name " / "Name (Foil) ", each with catalog_group = the set
//            /catalog/products/<id>?username=<anon>&details=true
//            -> market_price, price_history
//
// Output: collectr-prices.json, keyed by lowercased card name (as tcg-prices.json is):
//   { "abaddon succubus": { name, updatedAt,
//       prints: [ { set, finish:"Normal"|"Foil", id, price, priceText, url,
//                   history:[{d:"YYYY-MM-DD", p:7.26}, ...], updatedAt } ] } }
//
// Needs: playwright (already installed for scrape-tcg-prices.js). Merges into the existing
// file, so a card this run fails on keeps its last figures.

const fs = require('fs');
const { chromium } = require('playwright');

const API = 'https://api-v2.getcollectr.com';
const ANON = '00000000-0000-0000-0000-000000000000';
const CARDS_FILE = 'cards.json';
const OUT_FILE = 'collectr-prices.json';
const DELAY_MS = 350;
const CATEGORY = 'Sorcery: Contested Realm';
const GIVE_UP_AFTER = 12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyFor = (n) => n.trim().toLowerCase();
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// The call, made from inside the page. Returns { ok, status, json }.
async function apiGet(page, url) {
  return page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json, text/plain, */*' } });
      let j = null; try { j = await r.json(); } catch (e) {}
      return { ok: r.ok, status: r.status, json: j };
    } catch (e) { return { ok: false, status: 0, json: null, err: String(e) }; }
  }, url);
}

let refusals = 0;
async function getJSON(page, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await apiGet(page, url);
    if (r.ok && r.json) { refusals = 0; return r.json; }
    if (r.status === 403 || r.status === 429) {
      if (attempt === 0) { await sleep(2000); continue; }
      refusals++;
      if (refusals >= GIVE_UP_AFTER) {
        console.error('Refused ' + GIVE_UP_AFTER + ' times in a row (HTTP ' + r.status + ') even from the browser. Stopping; the existing file is kept.');
        process.exit(2);
      }
    }
    throw new Error('HTTP ' + r.status + (r.err ? ' ' + r.err : '') + ' ' + url);
  }
}

async function findProducts(page, name) {
  const u = API + '/catalog/suggestions?username=' + ANON + '&searchString=' + encodeURIComponent(name) + '&offset=0&limit=10';
  const j = await getJSON(page, u);
  const want = keyFor(name);
  return (j.data || []).filter((p) => {
    if (p.catalog_category_name !== CATEGORY) return false;
    return keyFor(String(p.product_name || '').replace(/\s*\(foil\)\s*$/i, '')) === want;
  }).map((p) => ({
    id: String(p.product_id),
    set: p.catalog_group || '',
    finish: /\(foil\)\s*$/i.test(String(p.product_name || '').trim()) ? 'Foil' : 'Normal'
  }));
}

async function productPrice(page, id) {
  const j = await getJSON(page, API + '/catalog/products/' + id + '?username=' + ANON + '&details=true');
  const d = j.data || {};
  const price = d.market_price != null ? parseFloat(d.market_price) : null;
  const hist = (d.price_history || [])
    .filter((x) => x && x.insertion_date && x.price != null)
    .map((x) => ({ d: String(x.insertion_date).slice(0, 10), p: Math.round(parseFloat(x.price) * 100) / 100 }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => a.d.localeCompare(b.d))
    .slice(-180);
  return { price: Number.isFinite(price) ? Math.round(price * 100) / 100 : null, history: hist };
}

async function main() {
  if (!fs.existsSync(CARDS_FILE)) { console.error('cards.json not found'); process.exit(1); }
  const cards = (JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')).cards || []);
  if (!cards.length) { console.error('cards.json has no cards'); process.exit(1); }

  let out = {};
  if (fs.existsSync(OUT_FILE)) { try { out = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) || {}; } catch (e) {} }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US'
  });
  const page = await context.newPage();
  // The app's own page: every call below is made from this origin.
  await page.goto('https://app.getcollectr.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // A first call as a check, so a blocked run says so at once rather than after 1,100 lines.
  const probe = await apiGet(page, API + '/catalog/suggestions?username=' + ANON + '&searchString=abaddon&offset=0&limit=3');
  console.log('Probe: HTTP ' + probe.status + (probe.ok ? ' OK' : ' -- refused' + (probe.err ? ' (' + probe.err + ')' : '')));
  if (!probe.ok) { await browser.close(); process.exit(2); }

  let found = 0, missing = 0, failed = 0;
  for (let i = 0; i < cards.length; i++) {
    const name = cards[i].n; if (!name) continue;
    try {
      const prods = await findProducts(page, name);
      await sleep(DELAY_MS);
      if (!prods.length) { missing++; continue; }
      const prints = [];
      for (const p of prods) {
        try {
          const pr = await productPrice(page, p.id);
          prints.push({
            set: p.set, finish: p.finish, id: p.id,
            price: pr.price, priceText: pr.price != null ? ('$' + pr.price.toFixed(2)) : null,
            history: pr.history, updatedAt: Date.now(),
            url: 'https://app.getcollectr.com/explore/product/' + p.id + '/' + slug('sorcery contested realm ' + p.set + ' ' + name)
          });
        } catch (e) { console.warn('  product ' + p.id + ' failed: ' + e.message); }
        await sleep(DELAY_MS);
      }
      if (prints.length) { out[keyFor(name)] = { name, updatedAt: Date.now(), prints }; found++; }
      else missing++;
    } catch (e) {
      failed++; console.warn('Failed "' + name + '": ' + e.message);
    }
    if (i % 25 === 0) console.log('Progress ' + (i + 1) + '/' + cards.length + ' (found=' + found + ' missing=' + missing + ' failed=' + failed + ')');
  }
  await browser.close();
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log('Wrote ' + OUT_FILE + ': ' + found + ' found, ' + missing + ' not on Collectr, ' + failed + ' failed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
