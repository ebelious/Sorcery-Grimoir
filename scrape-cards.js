const { chromium } = require('playwright');
const fs = require('fs');

// Card library, sorted alphabetically so results are stable across runs
const CARDS_URL = 'https://curiosa.io/cards#search=eyJxdWVyeSI6IiIsInNldCI6IioiLCJmaWx0ZXJzIjpbXSwiY3NvcnQiOiJuYW1lIiwiZHNvcnQiOiJuYW1lIiwiZnNvcnQiOiJuYW1lIiwiZGl2aWRlciI6ImFsbCIsImF2YXRhciI6IioifQ==';

// Map curiosa's element/type/rarity labels to the short codes already
// used in index.html's CARDS array (el/t/r fields).
const EL_MAP = { air: 'air', earth: 'earth', fire: 'fire', water: 'water', elemental: 'neutral', none: 'neutral', neutral: 'neutral' };
const TYPE_MAP = { minion: 'minion', magic: 'magic', artifact: 'artifact', aura: 'aura', site: 'site', avatar: 'avatar' };
const RARITY_MAP = { ordinary: 'ordinary', exceptional: 'exceptional', elite: 'elite', unique: 'unique' };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // ── Intercept every card.search response ──────────────────────────────────
  const rawResponses = [];
  page.on('response', async (response) => {
    if (!response.url().includes('card.search')) return;
    try {
      const json = await response.json();
      rawResponses.push(json);
    } catch (e) {}
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function lower(s) { return (s || '').toString().toLowerCase(); }

  function norm(item) {
    if (!item?.name || !item?.slug) return null;

    const el = EL_MAP[lower(item.element || item.elements?.[0])] || 'neutral';
    const t = TYPE_MAP[lower(item.type || item.category)] || 'minion';
    const r = RARITY_MAP[lower(item.rarity)] || 'ordinary';
    const setName = item.set?.name || item.setName || item.edition || '';
    const allSets = Array.isArray(item.sets)
      ? item.sets.map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean)
      : (setName ? [setName] : []);

    let th = '';
    if (Array.isArray(item.thresholds)) {
      th = item.thresholds.map(x => (typeof x === 'string' ? x : `${x.count || 1}${(x.element || '')[0] || ''}`)).join(' ');
    } else if (typeof item.threshold === 'string') {
      th = item.threshold;
    }

    return {
      n:  item.name,
      el,
      t,
      c:  (item.cost === undefined || item.cost === null) ? null : Number(item.cost),
      pw: (item.power === undefined || item.power === null) ? null : Number(item.power),
      r,
      s:  setName || (allSets[0] || ''),
      ss: allSets.length ? allSets : (setName ? [setName] : []),
      txt: item.text || item.rulesText || item.description || '',
      ar: item.artist || item.illustrator || '',
      th,
      sl: item.slug,
    };
  }

  const seen  = new Set();
  const cards = [];

  function absorb(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 14) return;
    if (Array.isArray(obj)) {
      if (obj.length && obj[0]?.slug && obj[0]?.name !== undefined) {
        obj.forEach(item => {
          const c = norm(item);
          if (c && !seen.has(c.sl)) { seen.add(c.sl); cards.push(c); }
        });
      } else {
        obj.forEach(v => absorb(v, depth + 1));
      }
    } else {
      Object.values(obj).forEach(v => absorb(v, depth + 1));
    }
  }

  // ── Load page and scroll to trigger all lazy loads ────────────────────────
  console.log('Loading page...');
  await page.goto(CARDS_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  console.log(`After initial load: ${rawResponses.length} API response(s) intercepted`);

  let scrollRounds = 0;
  let lastCount    = 0;
  let staleRounds  = 0;

  while (scrollRounds < 300 && staleRounds < 6) {
    try {
      const btn = await page.$(
        'button:has-text("Load More"), button:has-text("Show More"), button:has-text("load more"), [data-testid="load-more"]'
      );
      if (btn && await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(1200);
        scrollRounds++;
        continue;
      }
    } catch (_) {}

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const el = document.querySelector('main, [role="main"], .card-list, .cards-container, #card-list');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(700);

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

  for (const resp of rawResponses) {
    absorb(resp, 0);
  }
  console.log(`Cards after absorbing all responses: ${cards.length}`);

  await browser.close();

  if (!cards.length) {
    console.error('No cards scraped.');
    process.exit(1);
  }

  cards.sort((a, b) => a.n.localeCompare(b.n));

  fs.writeFileSync(
    'cards.json',
    JSON.stringify({ updated: new Date().toISOString(), total: cards.length, cards }, null, 2)
  );
  console.log('✓ Wrote cards.json');
})();
