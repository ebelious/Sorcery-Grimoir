const { chromium } = require('playwright');
const fs = require('fs');

const DECKS_URL = 'https://curiosa.io/decks#search=eyJxdWVyeSI6IiIsInNldCI6IioiLCJmaWx0ZXJzIjpbXSwiY3NvcnQiOiJyZWxldmFuY2UiLCJkc29ydCI6InJlbGV2YW5jZSIsImZzb3J0IjoicmVsZXZhbmNlIiwiZGl2aWRlciI6ImFsbCIsImF2YXRhciI6IioifQ';
const TRPC_URL  = 'https://curiosa.io/api/trpc/deck.search';
const CDN       = 'https://d27a44hjr9gen3.cloudfront.net/cards/';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Intercept the first deck.search response to capture exact input shape + response shape
  let firstInput  = null;
  let firstResp   = null;

  page.on('request', req => {
    const url = req.url();
    if (!url.includes('deck.search')) return;
    try {
      const raw   = new URL(url).searchParams.get('input');
      const parsed = JSON.parse(decodeURIComponent(raw));
      firstInput = parsed?.['0']?.json || parsed;
      console.log('Captured input shape:', JSON.stringify(firstInput));
    } catch(e) {}
  });

  page.on('response', async response => {
    if (firstResp) return;
    if (!response.url().includes('deck.search')) return;
    try {
      firstResp = await response.json();
    } catch(e) {}
  });

  console.log('Loading page...');
  await page.goto(DECKS_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);

  if (!firstInput) {
    console.error('Did not intercept deck.search request — page may not have loaded properly');
    await browser.close();
    process.exit(1);
  }

  console.log('\nFirst response structure:');
  if (firstResp) console.log(JSON.stringify(firstResp).slice(0, 1000));

  // ── Normalise ─────────────────────────────────────────────────────────────
  function thumbFromSlug(slug) {
    return slug ? CDN + slug + '.png' : '';
  }

  function getThumb(item) {
    if (item.thumbnailUrl?.startsWith('http')) return item.thumbnailUrl;
    if (item.thumbnail?.startsWith('http'))    return item.thumbnail;
    if (item.imageUrl?.startsWith('http'))     return item.imageUrl;
    for (const k of ['featuredCard','coverCard','avatarCard','mainCard']) {
      const c = item[k];
      if (!c || typeof c !== 'object') continue;
      if (c.thumbnailUrl?.startsWith('http')) return c.thumbnailUrl;
      if (c.imageUrl?.startsWith('http'))     return c.imageUrl;
      if (c.image?.startsWith('http'))        return c.image;
      const sl = c.slug || c.cardSlug || c.id;
      if (sl) return thumbFromSlug(sl);
    }
    for (const k of ['featuredCardSlug','coverCardSlug','cardSlug','thumbnailSlug','avatarSlug']) {
      if (item[k]) return thumbFromSlug(item[k]);
    }
    if (item.avatar && typeof item.avatar === 'object') {
      const sl = item.avatar.slug || item.avatar.cardSlug;
      if (sl) return thumbFromSlug(sl);
    }
    return '';
  }

  function norm(item) {
    if (!item?.id) return null;
    const author =
      (item.user && (item.user.username || item.user.displayName || item.user.name)) ||
      (item.creator && (item.creator.username || item.creator.name)) ||
      item.author || item.username || '';
    const avatar =
      (item.avatar && typeof item.avatar === 'object' && (item.avatar.name || item.avatar.cardName)) ||
      item.avatarName || item.avatarCard || '';
    let elements = [];
    if (Array.isArray(item.elements))
      elements = item.elements.map(e => typeof e === 'string' ? e : (e.name || e.label || '')).filter(Boolean);
    const upd = item.updatedAt || item.updated_at || '';
    return {
      id: item.id, name: item.name || 'Unnamed',
      author, avatar, elements,
      format:      item.format || item.deckFormat || 'Constructed',
      description: item.description || '',
      cardCount:   item.cardCount || (Array.isArray(item.cards) ? item.cards.length : 0) || 0,
      likes:       item.likes || item.likesCount || item._count?.likes || 0,
      views:       item.views || item.viewsCount || item._count?.views || 0,
      updatedAt:   upd ? (() => { try { return new Date(upd).toISOString().split('T')[0]; } catch(e) { return ''; }})() : '',
      thumbnail:   getThumb(item),
      url: 'https://curiosa.io/decks/' + item.id
    };
  }

  const seen  = new Set();
  const decks = [];

  function absorbArray(arr) {
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    arr.forEach(item => {
      const d = norm(item);
      if (d && !seen.has(d.id)) { seen.add(d.id); decks.push(d); n++; }
    });
    return n;
  }

  function walkAbsorb(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 14) return;
    if (Array.isArray(obj)) {
      if (obj.length && obj[0]?.id && obj[0]?.name) absorbArray(obj);
      else obj.forEach(v => walkAbsorb(v, depth+1));
    } else {
      Object.values(obj).forEach(v => walkAbsorb(v, depth+1));
    }
  }

  function findCursor(obj, d) {
    if (!obj || typeof obj !== 'object' || d > 8) return null;
    for (const k of ['nextCursor','next_cursor','cursor','endCursor','after']) {
      if (obj[k] && typeof obj[k] === 'string' && obj[k].length > 1) return obj[k];
    }
    for (const v of Object.values(obj)) {
      const r = findCursor(v, d + 1);
      if (r) return r;
    }
    return null;
  }

  // Absorb first page from intercepted response
  if (firstResp) {
    walkAbsorb(firstResp);
    console.log(`\nFirst page: ${decks.length} decks`);
    if (decks.length > 0) {
      console.log('Sample deck keys:', Object.keys(decks[0]).join(', '));
      console.log('Sample thumbnail:', decks[0].thumbnail || '(empty)');
    }
  }

  const firstCursor = firstResp ? findCursor(firstResp, 0) : null;
  console.log('First cursor:', firstCursor);

  // ── Paginate using browser's fetch (has session cookies) ──────────────────
  let cursor = firstCursor;
  let pageN  = 1; // already got page 0

  while (cursor && pageN < 100) {
    const inp = { ...firstInput, cursor };
    const url = `${TRPC_URL}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: inp } }))}`;

    try {
      const data = await page.evaluate(async (fetchUrl) => {
        const r = await fetch(fetchUrl, { headers: { accept: 'application/json' } });
        if (!r.ok) return null;
        return r.json();
      }, url);

      if (!data) { console.log(`Page ${pageN}: fetch returned null`); break; }

      const before = decks.length;
      walkAbsorb(data);
      const added = decks.length - before;
      const nc    = findCursor(data, 0);

      console.log(`Page ${pageN}: +${added} (total ${decks.length}), next=${nc ? nc.slice(0,20)+'...' : 'none'}`);

      if (!nc || added === 0) break;
      cursor = nc;
      pageN++;

      await page.waitForTimeout(200);
    } catch(e) {
      console.log('Error page', pageN, ':', e.message);
      break;
    }
  }

  await browser.close();

  if (!decks.length) {
    console.error('No decks found.');
    process.exit(1);
  }

  const withThumb = decks.filter(d => d.thumbnail).length;
  console.log(`\nTotal: ${decks.length} decks, ${withThumb} with thumbnails`);

  // Clean concatenated metadata from names
  decks.forEach(d => {
    d.name = d.name
      .replace(/\s*\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago.*/i, '')
      .replace(/\s*(Constructed|Draft|Sealed|Limited)\s*@.*/i, '')
      .replace(/\s*@[^\s]+$/, '')
      .replace(/^(Primer|New|Update)\s+/i, '')
      .trim() || d.name;
  });

  decks.sort((a, b) => (b.views || 0) - (a.views || 0));

  fs.writeFileSync('decks.json', JSON.stringify({
    updated: new Date().toISOString(),
    total:   decks.length,
    decks
  }, null, 2));

  console.log('✓ Wrote decks.json');
})();
