const { chromium } = require('playwright');
const fs = require('fs');

const DECKS_URL = 'https://curiosa.io/decks#search=eyJxdWVyeSI6IiIsInNldCI6IioiLCJmaWx0ZXJzIjpbXSwiY3NvcnQiOiJyZWxldmFuY2UiLCJkc29ydCI6InJlbGV2YW5jZSIsImZzb3J0IjoicmVsZXZhbmNlIiwiZGl2aWRlciI6ImFsbCIsImF2YXRhciI6IioifQ';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const captured = []; // { url, json }

  page.on('response', async response => {
    const url = response.url();
    const ct  = response.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    try {
      const text = await response.text();
      if (text.length < 20 || text.length > 20_000_000) return;
      const json = JSON.parse(text);
      captured.push({ url, json });
    } catch (e) {}
  });

  console.log('Loading page...');
  await page.goto(DECKS_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);

  // Scroll to load more
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
  }

  const cookies  = await context.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  await browser.close();

  // ── Print every URL we saw ────────────────────────────────────────────────
  console.log('\n=== ALL API URLS ===');
  captured.forEach(c => console.log(c.url));
  console.log('===================\n');

  // ── Find the one that looks like a deck list ──────────────────────────────
  // Look for any response containing an array of objects with id + name fields
  let deckUrl = null;
  let deckProc = null;
  let sampleDeck = null;

  for (const { url, json } of captured) {
    // Recursively find first array of deck-like objects
    function findDecks(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 10) return null;
      if (Array.isArray(obj)) {
        if (obj.length > 0 && obj[0] && typeof obj[0] === 'object' && obj[0].id && obj[0].name) {
          return obj;
        }
        for (const v of obj) { const r = findDecks(v, depth+1); if (r) return r; }
      } else {
        // Check Algolia hits
        if (obj.hits && Array.isArray(obj.hits) && obj.hits.length > 0 && obj.hits[0].id) return obj.hits;
        if (obj.results && Array.isArray(obj.results) && obj.results[0]?.hits?.length > 0) return obj.results[0].hits;
        for (const v of Object.values(obj)) { const r = findDecks(v, depth+1); if (r) return r; }
      }
      return null;
    }
    const arr = findDecks(json, 0);
    if (arr && arr.length > 0) {
      deckUrl  = url;
      sampleDeck = arr[0];
      if (url.includes('/trpc/')) {
        const m = url.match(/\/trpc\/([^?&,]+)/);
        if (m) deckProc = m[1];
      }
      console.log(`\n✓ Found deck array at: ${url}`);
      console.log(`  Procedure: ${deckProc}`);
      console.log(`  Sample deck keys: ${Object.keys(sampleDeck).join(', ')}`);
      console.log(`  Sample deck (first item):\n${JSON.stringify(sampleDeck, null, 2).slice(0, 2000)}`);
      break;
    }
  }

  if (!sampleDeck) {
    console.error('\n✗ No deck data found in any API response.');
    console.error('The page may require authentication, or uses a non-JSON API (like Algolia with a separate app key).');
    console.error('\nFull response dump:');
    captured.forEach(({url, json}) => {
      console.log(`\n--- ${url} ---`);
      console.log(JSON.stringify(json).slice(0, 500));
    });
    process.exit(1);
  }

  // ── Now paginate using what we discovered ─────────────────────────────────
  const seen  = new Set();
  const decks = [];

  function normalise(item) {
    if (!item || !item.id) return null;
    // Print all field names from first item to debug thumbnail field name
    if (decks.length === 0 && seen.size === 0) {
      console.log('\nAll fields on first deck item:', Object.keys(item).join(', '));
      // Print any field that looks like an image URL
      Object.entries(item).forEach(([k, v]) => {
        if (typeof v === 'string' && (v.includes('http') && (v.includes('.jpg') || v.includes('.png') || v.includes('.webp') || v.includes('image') || v.includes('cdn') || v.includes('thumb')))) {
          console.log(`  IMAGE FIELD: ${k} = ${v}`);
        }
        if (typeof v === 'object' && v) {
          Object.entries(v).forEach(([k2, v2]) => {
            if (typeof v2 === 'string' && v2.includes('http')) console.log(`  NESTED: ${k}.${k2} = ${v2.slice(0,100)}`);
          });
        }
      });
    }

    // Try every conceivable thumbnail field name
    const thumbnail =
      item.thumbnailUrl     || item.thumbnail      || item.previewImageUrl ||
      item.coverImage       || item.image           || item.imageUrl        ||
      item.deckImage        || item.preview         || item.bannerUrl       ||
      item.cover            || item.cardImage       || item.img             ||
      item.photo            || item.picture         || item.artwork         ||
      item['thumbnail_url'] || item['image_url']    || item['cover_image']  ||
      item['card_image']    || item['deck_image']   || item['preview_url']  ||
      (item.featuredCard  && (item.featuredCard.thumbnailUrl || item.featuredCard.imageUrl || item.featuredCard.image || item.featuredCard.img || item.featuredCard.src)) ||
      (item.coverCard     && (item.coverCard.thumbnailUrl    || item.coverCard.imageUrl    || item.coverCard.image   || item.coverCard.img  || item.coverCard.src))    ||
      (item.avatarCard    && typeof item.avatarCard === 'object' && (item.avatarCard.imageUrl || item.avatarCard.image || item.avatarCard.thumbnailUrl)) ||
      (item.avatar        && typeof item.avatar    === 'object' && (item.avatar.imageUrl    || item.avatar.image     || item.avatar.thumbnailUrl || item.avatar.img))  ||
      (item.cards && Array.isArray(item.cards) && item.cards[0] && (item.cards[0].thumbnailUrl || item.cards[0].imageUrl || item.cards[0].image)) ||
      '';

    let elements = [];
    if (Array.isArray(item.elements))
      elements = item.elements.map(e => typeof e === 'string' ? e : (e.name || e.label || '')).filter(Boolean);

    const author =
      (item.user    && (item.user.username || item.user.displayName || item.user.name)) ||
      (item.creator && (item.creator.username || item.creator.name)) ||
      item.author || item.username || '';

    const avatar =
      (item.avatar && typeof item.avatar === 'object' && (item.avatar.name || item.avatar.cardName)) ||
      item.avatarName || item.avatarCard || '';

    const updated = item.updatedAt || item.updated_at || '';
    return {
      id: item.id,
      name: item.name || item.title || 'Unnamed Deck',
      author, avatar, elements,
      format:      item.format || item.deckFormat || 'Constructed',
      description: item.description || '',
      cardCount:   item.cardCount || (Array.isArray(item.cards) ? item.cards.length : 0) || 0,
      likes:       item.likes || item.likesCount || item._count?.likes || 0,
      views:       item.views || item.viewsCount || item._count?.views || 0,
      updatedAt:   updated ? (() => { try { return new Date(updated).toISOString().split('T')[0]; } catch(e) { return ''; }})() : '',
      thumbnail,
      url: 'https://curiosa.io/decks/' + item.id
    };
  }

  function absorb(arr) {
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    arr.forEach(item => {
      const d = normalise(item);
      if (d && !seen.has(d.id)) { seen.add(d.id); decks.push(d); n++; }
    });
    return n;
  }

  function walkAbsorb(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 14) return;
    if (Array.isArray(obj)) { absorb(obj); obj.forEach(v => walkAbsorb(v, depth+1)); }
    else {
      if (obj.hits) absorb(obj.hits);
      if (obj.results) obj.results.forEach(r => r?.hits && absorb(r.hits));
      Object.values(obj).forEach(v => walkAbsorb(v, depth+1));
    }
  }

  // Absorb everything we already captured
  captured.forEach(({ json }) => walkAbsorb(json, 0));
  console.log(`\nAfter initial page: ${decks.length} decks`);

  // ── Paginate if we found the procedure ──────────────────────────────────
  if (deckProc && deckUrl) {
    const base = deckUrl.split('/trpc/')[0] + '/trpc/';
    const searchInput = { query: '', set: '*', filters: [], csort: 'relevance', dsort: 'relevance', fsort: 'relevance', divider: 'all', avatar: '*', limit: 50 };

    let cursor = null;
    let pageN  = 0;

    function findCursor(obj, d) {
      if (!obj || typeof obj !== 'object' || d > 8) return null;
      for (const k of ['nextCursor','next_cursor','cursor','endCursor','after']) {
        if (obj[k] && typeof obj[k] === 'string' && obj[k].length > 1) return obj[k];
      }
      for (const v of Object.values(obj)) { const r = findCursor(v, d+1); if (r) return r; }
      return null;
    }

    while (pageN < 50) {
      const inp  = { ...searchInput, ...(cursor ? { cursor } : {}) };
      const url  = `${base}${deckProc}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: inp } }))}`;

      try {
        const resp = await fetch(url, { headers: { cookie: cookieStr, accept: 'application/json' } });
        if (!resp.ok) { console.log(`HTTP ${resp.status} — stopping`); break; }
        const data = await resp.json();
        const before = decks.length;
        walkAbsorb(data, 0);
        const added = decks.length - before;
        const nc = findCursor(data, 0);
        console.log(`Page ${pageN}: +${added} decks (total ${decks.length}), nextCursor=${nc ? nc.slice(0,20) : 'none'}`);
        if (!nc || added === 0) break;
        cursor = nc;
        pageN++;
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.log('Error:', e.message);
        break;
      }
    }
  }

  if (!decks.length) {
    console.error('No decks collected.');
    process.exit(1);
  }

  // Report thumbnail coverage
  const withThumb = decks.filter(d => d.thumbnail).length;
  console.log(`\nThumbnail coverage: ${withThumb}/${decks.length} (${Math.round(withThumb/decks.length*100)}%)`);

  const cleaned = decks.map(d => ({
    ...d,
    name: d.name
      .replace(/\s*\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago.*/i, '')
      .replace(/\s*(Constructed|Draft|Sealed|Limited)\s*@.*/i, '')
      .replace(/\s*@[^\s]+$/, '')
      .replace(/^(Primer|New|Update)\s+/i, '')
      .trim() || d.name
  }));

  cleaned.sort((a, b) => (b.views || 0) - (a.views || 0));
  fs.writeFileSync('decks.json', JSON.stringify({ updated: new Date().toISOString(), total: cleaned.length, decks: cleaned }, null, 2));
  console.log(`\n✓ Wrote ${cleaned.length} decks to decks.json`);
  console.log(`  ${withThumb} have thumbnail images`);
})();
