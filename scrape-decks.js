const { chromium } = require('playwright');
const fs = require('fs');

const DECKS_URL = 'https://curiosa.io/decks#search=eyJxdWVyeSI6IiIsInNldCI6IioiLCJmaWx0ZXJzIjpbXSwiY3NvcnQiOiJyZWxldmFuY2UiLCJkc29ydCI6InJlbGV2YW5jZSIsImZzb3J0IjoicmVsZXZhbmNlIiwiZGl2aWRlciI6ImFsbCIsImF2YXRhciI6IioifQ';

// The exact search input shape curiosa.io uses
const BASE_SEARCH_INPUT = {
  query: '',
  set: '*',
  filters: [],
  csort: 'relevance',
  dsort: 'relevance',
  fsort: 'relevance',
  divider: 'all',
  avatar: '*'
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const allResponses = [];
  let tRPCBase = null;
  let deckProcedure = null;

  page.on('response', async response => {
    const url  = response.url();
    const ct   = response.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    try {
      const text = await response.text();
      if (text.length < 20 || text.length > 20_000_000) return;
      const json = JSON.parse(text);
      allResponses.push({ url, json, text });

      // Detect tRPC base and procedure name from URL
      if (url.includes('/trpc/') || url.includes('/api/trpc/')) {
        const m = url.match(/\/trpc\/([^?&]+)/);
        if (m) {
          deckProcedure = m[1].split('?')[0].split(',')[0];
          tRPCBase = url.split('/trpc/')[0] + '/trpc/';
          console.log('tRPC URL detected:', url.slice(0, 150));
          console.log('  procedure:', deckProcedure);
        }
      }
    } catch (e) {}
  });

  console.log('Loading:', DECKS_URL);
  await page.goto(DECKS_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Scroll down to trigger more loads
  let prevH = 0;
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === prevH && i > 3) break;
    prevH = h;
  }

  const nextData = await page.evaluate(() => {
    try { return JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null'); }
    catch(e) { return null; }
  });

  const cookies  = await context.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  console.log('\n=== ALL JSON URLS SEEN ===');
  [...new Set(allResponses.map(r => r.url))].forEach(u => console.log(u));
  console.log('==========================\n');
  console.log('tRPC base:', tRPCBase);
  console.log('Deck procedure:', deckProcedure);

  await browser.close();

  // ── Normalise ─────────────────────────────────────────────────────────────
  function normalise(item) {
    if (!item || typeof item !== 'object') return null;
    const id = item.id || item.slug || item.objectID;
    if (!id || typeof id !== 'string' || id.length < 4) return null;

    const thumbnail =
      item.thumbnailUrl     || item.thumbnail      || item.previewImageUrl ||
      item.coverImage       || item.image           || item.imageUrl        ||
      item.deckImage        || item.preview         || item.bannerUrl       ||
      item.cover            || item.cardImage       || item.img             ||
      item['thumbnail_url'] || item['image_url']    ||
      (item.featuredCard  && (item.featuredCard.thumbnailUrl || item.featuredCard.imageUrl || item.featuredCard.image || item.featuredCard.img)) ||
      (item.coverCard     && (item.coverCard.thumbnailUrl    || item.coverCard.imageUrl    || item.coverCard.image))    ||
      (item.avatarCard    && typeof item.avatarCard === 'object' && (item.avatarCard.imageUrl || item.avatarCard.image)) ||
      (item.avatar        && typeof item.avatar    === 'object' && (item.avatar.imageUrl    || item.avatar.image || item.avatar.thumbnailUrl)) ||
      (item.cards && Array.isArray(item.cards) && item.cards[0] && (item.cards[0].thumbnailUrl || item.cards[0].imageUrl)) ||
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
      id, name: item.name || item.title || 'Unnamed Deck',
      author, avatar, elements,
      format:      item.format || item.deckFormat || 'Constructed',
      description: item.description || '',
      cardCount:   item.cardCount || (Array.isArray(item.cards) ? item.cards.length : 0) || 0,
      likes:       item.likes || item.likesCount || item._count?.likes || 0,
      views:       item.views || item.viewsCount || item._count?.views || 0,
      updatedAt:   updated ? (() => { try { return new Date(updated).toISOString().split('T')[0]; } catch(e) { return ''; }})() : '',
      thumbnail,
      url: 'https://curiosa.io/decks/' + id
    };
  }

  const seen  = new Set();
  const decks = [];

  function absorb(arr, src) {
    if (!Array.isArray(arr) || !arr.length) return 0;
    const f = arr[0];
    if (!f || typeof f !== 'object' || (!f.id && !f.slug && !f.objectID && !f.name)) return 0;
    let n = 0;
    arr.forEach(item => {
      const d = normalise(item);
      if (d && !seen.has(d.id)) { seen.add(d.id); decks.push(d); n++; }
    });
    if (n) console.log(`  +${n} from ${src.slice(0,70)}`);
    return n;
  }

  function walkAll(obj, depth, src) {
    if (!obj || typeof obj !== 'object' || depth > 16) return;
    if (Array.isArray(obj)) {
      absorb(obj, src);
      obj.forEach(v => walkAll(v, depth+1, src));
    } else {
      // Also handle Algolia hits
      if (obj.hits && Array.isArray(obj.hits)) absorb(obj.hits, src + '/hits');
      if (obj.results && Array.isArray(obj.results)) obj.results.forEach((r,i) => { if (r?.hits) absorb(r.hits, src + `/results[${i}].hits`); });
      Object.values(obj).forEach(v => walkAll(v, depth+1, src));
    }
  }

  // Step 1: __NEXT_DATA__
  if (nextData) walkAll(nextData, 0, '__NEXT_DATA__');

  // Step 2: intercepted responses
  for (const { url, json } of allResponses) walkAll(json, 0, url);

  console.log(`After page load: ${decks.length} decks`);

  // Step 3: paginate using discovered tRPC procedure
  if (tRPCBase && deckProcedure) {
    console.log(`Paginating via ${tRPCBase}${deckProcedure}...`);
    let cursor = null;
    let page_n = 0;

    while (page_n < 50) {
      const inputObj = { ...BASE_SEARCH_INPUT, limit: 50, ...(cursor ? { cursor } : {}) };
      const url = `${tRPCBase}${deckProcedure}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: inputObj } }))}`;

      try {
        const resp = await fetch(url, { headers: { cookie: cookieStr, accept: 'application/json' } });
        if (!resp.ok) { console.log('  HTTP', resp.status, '— stopping pagination'); break; }
        const data = await resp.json();
        const before = decks.length;
        walkAll(data, 0, `page${page_n}`);
        const added = decks.length - before;
        console.log(`  Page ${page_n}: +${added} (total ${decks.length})`);

        // Find next cursor in response
        let nextCursor = null;
        function findCursor(obj, d) {
          if (!obj || typeof obj !== 'object' || d > 8) return null;
          for (const k of ['nextCursor','next_cursor','cursor','endCursor','after','nextPage']) {
            if (obj[k] && (typeof obj[k] === 'string' || typeof obj[k] === 'number')) return String(obj[k]);
          }
          for (const v of Object.values(obj)) { const r = findCursor(v, d+1); if (r) return r; }
          return null;
        }
        nextCursor = findCursor(data, 0);

        if (!nextCursor || added === 0) break;
        cursor = nextCursor;
        page_n++;
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.log('  Pagination error:', e.message);
        break;
      }
    }
  } else {
    // Try common procedure names directly
    const tryProcs = ['deck.search', 'deck.list', 'deck.browse', 'deck.getPublished', 'deck.getAll', 'decks.search', 'decks.list'];
    const tryBases = ['https://curiosa.io/api/trpc/', 'https://curiosa.io/trpc/'];

    for (const base of tryBases) {
      for (const proc of tryProcs) {
        try {
          const inputObj = { ...BASE_SEARCH_INPUT, limit: 50 };
          const url = `${base}${proc}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: inputObj } }))}`;
          const resp = await fetch(url, { headers: { cookie: cookieStr, accept: 'application/json' } });
          if (!resp.ok) continue;
          const data = await resp.json();
          const before = decks.length;
          walkAll(data, 0, proc);
          if (decks.length > before) {
            console.log(`Found working procedure: ${base}${proc}`);
            tRPCBase = base;
            deckProcedure = proc;
            break;
          }
        } catch(e) {}
      }
      if (deckProcedure) break;
    }
  }

  console.log(`\nTotal: ${decks.length} decks`);

  if (!decks.length) {
    console.error('\nNo decks found!');
    console.error('Check the URLs logged above. Look for the endpoint handling the deck search.');
    console.error('The search input shape is:', JSON.stringify(BASE_SEARCH_INPUT));
    process.exit(1);
  }

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
  console.log(`✓ Wrote ${cleaned.length} decks to decks.json`);
})();
