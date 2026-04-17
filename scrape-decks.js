const { chromium } = require('playwright');
const fs = require('fs');

const CDN = 'https://d27a44hjr9gen3.cloudfront.net/cards/';

// Sort by most-viewed so the best decks are first
const DECKS_URL = 'https://curiosa.io/decks#search=eyJxdWVyeSI6IiIsInNldCI6IioiLCJmaWx0ZXJzIjpbXSwiY3NvcnQiOiJ2aWV3cyIsImRzb3J0Ijoidmlld3MiLCJmc29ydCI6InZpZXdzIiwiZGl2aWRlciI6ImFsbCIsImF2YXRhciI6IioifQ==';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // ── Intercept every deck.search response ─────────────────────────────────────
  const rawResponses = [];
  page.on('response', async (response) => {
    if (!response.url().includes('deck.search')) return;
    try {
      const json = await response.json();
      rawResponses.push(json);
    } catch (e) {}
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function getThumb(item) {
    if (item.thumbnailUrl?.startsWith('http')) return item.thumbnailUrl;
    if (item.thumbnail?.startsWith('http'))    return item.thumbnail;
    if (item.imageUrl?.startsWith('http'))     return item.imageUrl;
    for (const k of ['featuredCard', 'coverCard', 'avatarCard', 'mainCard']) {
      const c = item[k];
      if (!c || typeof c !== 'object') continue;
      const url = c.thumbnailUrl || c.imageUrl || c.image || c.img;
      if (url?.startsWith('http')) return url;
      const sl = c.slug || c.cardSlug || c.id;
      if (sl) return CDN + sl + '.png';
    }
    for (const k of ['featuredCardSlug', 'coverCardSlug', 'cardSlug', 'thumbnailSlug', 'avatarSlug']) {
      if (item[k]) return CDN + item[k] + '.png';
    }
    return '';
  }

  function norm(item) {
    if (!item?.id) return null;
    const author =
      (item.user && (item.user.username || item.user.displayName || item.user.name)) ||
      (item.creator && (item.creator.username || item.creator.name)) ||
      item.author || '';
    // Skip archetype/template stubs with no real author
    if (!author) return null;
    const avatar =
      (item.avatar && typeof item.avatar === 'object' && (item.avatar.name || item.avatar.cardName)) ||
      item.avatarName || '';
    const elements = Array.isArray(item.elements)
      ? item.elements.map(e => (typeof e === 'string' ? e : e.name || e.label || '')).filter(Boolean)
      : [];
    let upd = item.updatedAt || item.updated_at || '';
    try { if (upd) upd = new Date(upd).toISOString().split('T')[0]; } catch (_) { upd = ''; }
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
      // A deck array: first element has id + name
      if (obj.length && obj[0]?.id && obj[0]?.name !== undefined) {
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

  // ── Load page and scroll to trigger all lazy loads ────────────────────────────
  console.log('Loading page...');
  await page.goto(DECKS_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  console.log(`After initial load: ${rawResponses.length} API response(s) intercepted`);

  // Scroll down repeatedly to trigger infinite scroll / load-more
  let scrollRounds = 0;
  let lastCount    = 0;
  let staleRounds  = 0;

  while (scrollRounds < 100 && staleRounds < 5) {
    // Try clicking any "Load More" / "Show More" button first
    try {
      const btn = await page.$(
        'button:has-text("Load More"), button:has-text("Show More"), button:has-text("load more"), [data-testid="load-more"]'
      );
      if (btn && await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(1500);
        console.log(`  Clicked load-more (round ${scrollRounds})`);
        scrollRounds++;
        continue;
      }
    } catch (_) {}

    // Scroll to bottom to trigger infinite scroll
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);

    // Also try scrolling the main content container (some SPAs use a div, not window)
    await page.evaluate(() => {
      const el = document.querySelector('main, [role="main"], .deck-list, .decks-container, #deck-list');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(800);

    const currentCount = rawResponses.length;
    if (currentCount === lastCount) {
      staleRounds++;
    } else {
      staleRounds = 0;
      console.log(`  Scroll round ${scrollRounds}: ${currentCount} responses (was ${lastCount})`);
    }
    lastCount = currentCount;
    scrollRounds++;
  }

  console.log(`\nDone scrolling. Total intercepted responses: ${rawResponses.length}`);

  // ── Absorb all intercepted responses ─────────────────────────────────────────
  for (const resp of rawResponses) {
    absorb(resp, 0);
  }
  console.log(`Decks after absorbing all responses: ${decks.length}`);

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
  console.log(`Final: ${decks.length} decks, ${withThumb} with thumbnails`);

  fs.writeFileSync(
    'decks.json',
    JSON.stringify({ updated: new Date().toISOString(), total: decks.length, decks }, null, 2)
  );
  console.log('✓ Wrote decks.json');
})();
