// Collectr market prices for every card in cards.json, on the same schedule as the TCGPlayer
// sweep (add a step to scrape-tcg-prices.yml, or its own workflow). Plain fetch(): Collectr's
// app calls a public JSON API (api-v2.getcollectr.com) with no key and an anonymous
// "username", so no browser is needed.
//
// Per card:  GET /catalog/suggestions?username=<anon>&searchString=<name>&offset=0&limit=10
//            -> products, "Name " and "Name (Foil) ", each with catalog_group = the set
//            GET /catalog/products/<id>?username=<anon>&details=true
//            -> market_price, price_history, image
//
// Output: collectr-prices.json, keyed by lowercased card name (same convention as
// tcg-prices.json), committed to the repo and read straight by the app:
//   { "abaddon succubus": { name, updatedAt,
//       prints: [ { set:"Gothic", finish:"Normal"|"Foil", id:"666917", price:7.26,
//                   priceText:"$7.26", url:"https://app.getcollectr.com/explore/product/666917/..." } ] } }
//
// Node 18+ (global fetch). No dependencies.

const fs = require('fs');

const API = 'https://api-v2.getcollectr.com';
const ANON = '00000000-0000-0000-0000-000000000000';
const CARDS_FILE = 'cards.json';
const OUT_FILE = 'collectr-prices.json';
const DELAY_MS = 350;                     // between requests: easy on their API
const CATEGORY = 'Sorcery: Contested Realm';

// Exactly the headers the Collectr web app sends (read from a browser session's HAR): the
// API sits behind CloudFront, which answers 403 to a request that does not look like the
// app's own -- the fetch headers Origin/Referer and the Sec-Fetch-* set are what it checks.
const HDRS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://app.getcollectr.com',
  'Referer': 'https://app.getcollectr.com/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0',
  'Connection': 'keep-alive'
};
// If the API still refuses, it is refusing the runner's address, not the request; a run
// that is refused this many times in a row stops rather than logging a thousand lines.
const GIVE_UP_AFTER = 12;
let consecutiveRefusals = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyFor = (n) => n.trim().toLowerCase();
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function getJSON(url) {
  // one retry after a pause for a transient refusal; a second 403 is counted
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, { headers: HDRS });
    if (r.ok) { consecutiveRefusals = 0; return r.json(); }
    if (r.status === 403 || r.status === 429) {
      if (attempt === 0) { await sleep(1500); continue; }
      consecutiveRefusals++;
      if (consecutiveRefusals >= GIVE_UP_AFTER) {
        console.error('Refused ' + GIVE_UP_AFTER + ' times in a row (HTTP ' + r.status + '): the API is blocking this address, not these requests. Stopping; the existing file is kept.');
        process.exit(2);
      }
    }
    throw new Error('HTTP ' + r.status + ' ' + url);
  }
}

// Every Sorcery product whose name is exactly the card's name, plain or "(Foil)".
async function findProducts(name) {
  const u = API + '/catalog/suggestions?username=' + ANON + '&searchString=' + encodeURIComponent(name) + '&offset=0&limit=10';
  const j = await getJSON(u);
  const want = keyFor(name);
  return (j.data || []).filter((p) => {
    if (p.catalog_category_name !== CATEGORY) return false;
    const pn = keyFor(String(p.product_name || '').replace(/\s*\(foil\)\s*$/i, ''));
    return pn === want;
  }).map((p) => ({
    id: String(p.product_id),
    set: p.catalog_group || '',
    finish: /\(foil\)\s*$/i.test(String(p.product_name || '').trim()) ? 'Foil' : 'Normal',
    productName: String(p.product_name || '').trim()
  }));
}

async function productPrice(id) {
  const j = await getJSON(API + '/catalog/products/' + id + '?username=' + ANON + '&details=true');
  const d = j.data || {};
  const price = d.market_price != null ? parseFloat(d.market_price) : null;
  // the daily market history, oldest first, kept to the last 180 days; the app draws it
  const hist = (d.price_history || [])
    .filter((x) => x && x.insertion_date && x.price != null)
    .map((x) => ({ d: String(x.insertion_date).slice(0, 10), p: Math.round(parseFloat(x.price) * 100) / 100 }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => a.d.localeCompare(b.d))
    .slice(-180);
  return { price: Number.isFinite(price) ? Math.round(price * 100) / 100 : null, image: d.image_url || null, history: hist };
}

async function main() {
  if (!fs.existsSync(CARDS_FILE)) { console.error('cards.json not found'); process.exit(1); }
  const cards = (JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')).cards || []);
  if (!cards.length) { console.error('cards.json has no cards'); process.exit(1); }

  // Merge into what is there: a card this run fails on keeps its last figures.
  let out = {};
  if (fs.existsSync(OUT_FILE)) { try { out = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) || {}; } catch (e) {} }

  let found = 0, missing = 0, failed = 0;
  for (let i = 0; i < cards.length; i++) {
    const name = cards[i].n; if (!name) continue;
    try {
      const prods = await findProducts(name);
      await sleep(DELAY_MS);
      if (!prods.length) { missing++; continue; }
      const prints = [];
      for (const p of prods) {
        try {
          const pr = await productPrice(p.id);
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
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log('Wrote ' + OUT_FILE + ': ' + found + ' found, ' + missing + ' not on Collectr, ' + failed + ' failed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
