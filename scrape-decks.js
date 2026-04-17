const { chromium } = require('playwright');
const fs = require('fs');

const DECKS_URL = 'https://curiosa.io/decks';
const TRPC_URL  = 'https://curiosa.io/api/trpc/deck.search';
const CDN       = 'https://d27a44hjr9gen3.cloudfront.net/cards/';

// Correct input shape — matches what the browser actually sends
const BASE_INPUT = {
  query:   '',
  set:     '*',
  filters: [],
  csort:   'views',
  dsort:   'views',
  fsort:   'views',
  divider: 'all',
  avatar:  '*',
  limit:   100,
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  console.log('Loading page to establish session cookies...');
  await page.goto(DECKS_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  function getThumb(item) {
    if (item.thumbnailUrl?.startsWith('http')) return item.thumbnailUrl;
    if (item.thumbnail?.startsWith('http'))    return item.thumbnail;
    if (item.imageUrl?.startsWith('http'))     return item.imageUrl;
    for (const k of ['featuredCard','coverCard','avatarCard','mainCard']) {
      const c = item[k];
      if (!c || typeof c !== 'object') continue;
      const url = c.thumbnailUrl || c.imageUrl || c.image || c.img;
      if (url?.startsWith('http')) return url;
      const sl = c.slug || c.cardSlug || c.id;
      if (sl) return CDN + sl + '.png';
    }
    for (const k of ['featuredCardSlug','coverCardSlug','cardSlug','thumbnailSlug','avatarSlug']) {
      if (item[k]) return CDN + item[k] + '.png';
    }
    return '';
  }

  function norm(item) {
    if (!item?.id) return null;
    const author = (item.user && (item.user.username || item.user.displayName || item.user.name))
                || (item.creator && (item.creator.username || item.creator.name))
                || item.author || '';
    // Skip archetype/template decks that have no real author
    if (!author) return null;
    const avatar = (item.avatar && typeof item.avatar === 'object' && (item.avatar.name || item.avatar.cardName))
                || item.avatarName || '';
    let elements = [];
    if (Array.isArray(item.elements))
      elements = item.elements.map(e => typeof e === 'string' ? e : (e.name || e.label || '')).filter(Boolean);
    let upd = item.updatedAt || item.updated_at || '';
    try { if (upd) upd = new Date(upd).toISOString().split('T')[0]; } catch(e) { upd = ''; }
    return {
      id:          item.id,
      name:        item.name || 'Unnamed',
      author,
      avatar,
      elements,
      format:      item.format || 'Constructed',
      description: item.description || '',
      cardCount:   item.cardCount || (Array.isArray(item.cards) ? item.cards.length : 0) || 0,
      likes:       item.likes || item.likesCount || item._count?.likes || 0,
      views:       item.views || item.viewsCount || item._count?.views || 0,
      updatedAt:   upd,
      thumbnail:   getThumb(item),
      url:         'https://curiosa.io/decks/' + item.id,
    };
  }

  const seen  = new Set();
  const decks = [];

  function absorb(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 14) return;
    if (Array.isArray(obj)) {
      if (obj.length && obj[0]?.id && obj[0]?.name) {
        obj.forEach(item => {
          const d = norm(item);
          if (d && !seen.has(d.id)) { seen.add(d.id); decks.push(d); }
        });
      } else {
        obj.forEach(v => absorb(v, depth + 1));
      }
    } else {
      Object.values(obj).forEach(v => absorb(v, depth + 1));
    }
  }

  function findCursor(obj, d) {
    if (!obj || typeof obj !== 'object' || d > 10) return null;
    const keys = ['nextCursor','next_cursor','cursor','endCursor','after','nextPage','next'];
    for (const k of keys) {
      const v = obj[k];
      // Accept string or number cursors, but not null/undefined/empty
      if (v !== null && v !== undefined && v !== '') return v;
    }
    for (const v of Object.values(obj)) {
      const r = findCursor(v, d + 1);
      if (r !== null) return r;
    }
    return null;
  }

  // Fetch a page using browser context (preserves session cookies)
  async function fetchPage(inp) {
    const url = `${TRPC_URL}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: inp } }))}`;
    return page.evaluate(async (fetchUrl) => {
      const r = await fetch(fetchUrl, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, url);
  }

  // Page 0
  console.log('Fetching page 0...');
  let data = await fetchPage(BASE_INPUT);
  absorb(data, 0);
  console.log(`Page 0: ${decks.length} decks`);

  let cursor = findCursor(data, 0);
  let pageN  = 1;

  while (cursor !== null && cursor !== undefined && pageN < 200) {
    const inp = { ...BASE_INPUT, cursor };
    try {
      data = await fetchPage(inp);
    } catch(e) {
      console.log(`Page ${pageN} error: ${e.message}`);
      break;
    }

    const before = decks.length;
    absorb(data, 0);
    const added = decks.length - before;
    const nc    = findCursor(data, 0);

    console.log(`Page ${pageN}: +${added} (total ${decks.length}), next cursor: ${JSON.stringify(nc)}`);

    if (added === 0 || nc === cursor || nc === null || nc === undefined) break;

    cursor = nc;
    pageN++;
    await page.waitForTimeout(250);
  }

  await browser.close();

  if (!decks.length) {
    console.error('No decks scraped.');
    process.exit(1);
  }

  // Clean up names
  decks.forEach(d => {
    d.name = d.name
      .replace(/\s*\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago.*/i, '')
      .replace(/\s*(Constructed|Draft|Sealed|Limited)\s*@.*/i, '')
      .replace(/\s*@[^\s]+$/, '')
      .replace(/^(Primer|New|Update)\s+/i, '')
      .trim() || d.name;
  });

  // Sort by views descending
  decks.sort((a, b) => (b.views || 0) - (a.views || 0));

  const withThumb = decks.filter(d => d.thumbnail).length;
  console.log(`\nFinal: ${decks.length} decks, ${withThumb} with thumbnails`);

  fs.writeFileSync(
    'decks.json',
    JSON.stringify({ updated: new Date().toISOString(), total: decks.length, decks }, null, 2)
  );
  console.log('✓ Wrote decks.json');
})();
