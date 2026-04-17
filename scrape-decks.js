const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Intercept API calls — curiosa.io fetches deck data from its own API
  const apiCalls = [];
  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    // Catch any JSON responses that look like deck list API calls
    if (
      ct.includes('application/json') &&
      (url.includes('/api/') || url.includes('/trpc/') || url.includes('curiosa.io')) &&
      !url.includes('analytics') &&
      !url.includes('sentry')
    ) {
      try {
        const json = await response.json();
        apiCalls.push({ url, json });
      } catch (e) {}
    }
  });

  console.log('Navigating to https://curiosa.io/decks ...');
  await page.goto('https://curiosa.io/decks', {
    waitUntil: 'networkidle',
    timeout: 45000
  });

  // Give JS extra time to finish rendering
  await page.waitForTimeout(4000);

  await browser.close();

  // ── STRATEGY 1: Parse intercepted API/tRPC responses ────────────────────────
  let decks = [];
  const seen = new Set();

  for (const call of apiCalls) {
    const d = call.json;

    // Try common tRPC / REST response shapes for a deck array
    const candidates = [
      d?.result?.data?.decks,
      d?.result?.data?.json?.decks,
      d?.data?.decks,
      d?.decks,
      d?.result?.data,
      d?.data,
      Array.isArray(d) ? d : null
    ].filter(Boolean);

    for (const arr of candidates) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const first = arr[0];
      if (!first || (!first.id && !first.slug && !first.name)) continue;

      console.log(`Found deck array (${arr.length}) from: ${call.url}`);

      arr.forEach(item => {
        const id = item.id || item.slug || item._id;
        if (!id || seen.has(id)) return;
        seen.add(id);

        // Normalise elements — array of strings or objects
        let elements = [];
        if (Array.isArray(item.elements)) {
          elements = item.elements
            .map(e => (typeof e === 'string' ? e : e.name || e.label || ''))
            .filter(Boolean);
        } else if (typeof item.element === 'string') {
          elements = [item.element];
        }

        const thumbnail =
          item.thumbnailUrl ||
          item.thumbnail ||
          item.previewImageUrl ||
          item.coverImage ||
          item.image ||
          (item.featuredCard && item.featuredCard.imageUrl) ||
          '';

        const author =
          (item.user && (item.user.username || item.user.name || item.user.displayName)) ||
          item.author ||
          item.createdBy ||
          '';

        const avatar =
          (item.avatar && (item.avatar.name || item.avatar.cardName)) ||
          item.avatarName ||
          item.avatarCard ||
          '';

        const likes  = item.likes     || item.likesCount  || item.likeCount  || item._count?.likes  || 0;
        const views  = item.views     || item.viewsCount  || item.viewCount  || item._count?.views  || 0;
        const cards  = item.cardCount || item.cards_count ||
                       (Array.isArray(item.cards) ? item.cards.length : 0) || 0;
        const updated = item.updatedAt || item.updated_at || item.lastUpdated || '';

        decks.push({
          id,
          name:        item.name || item.title || 'Unnamed Deck',
          author,
          avatar,
          elements,
          format:      item.format || item.deckFormat || 'Constructed',
          description: item.description || item.desc || '',
          cardCount:   cards,
          likes,
          views,
          updatedAt:   updated ? new Date(updated).toISOString().split('T')[0] : '',
          thumbnail,
          url: 'https://curiosa.io/decks/' + id
        });
      });

      if (decks.length >= 24) break;
    }
    if (decks.length >= 24) break;
  }

  // ── STRATEGY 2: DOM scraping fallback ───────────────────────────────────────
  if (!decks.length) {
    console.log('No API data found — falling back to DOM scraping...');

    const browser2 = await chromium.launch({ headless: true });
    const page2 = await browser2.newPage();
    await page2.goto('https://curiosa.io/decks', { waitUntil: 'networkidle', timeout: 45000 });
    await page2.waitForTimeout(4000);

    decks = await page2.evaluate(() => {
      const results = [];
      const seen = new Set();

      document.querySelectorAll('a[href*="/decks/"]').forEach(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/decks\/([a-zA-Z0-9_-]+)/);
        if (!m) return;
        const id = m[1];
        if (!id || id === 'new' || id === 'import' || seen.has(id)) return;
        seen.add(id);

        const card    = a.closest('article,[class*="card"],[class*="deck"],li');
        const nameEl  = card && card.querySelector('h2,h3,h4,[class*="name"],[class*="title"]');
        const authEl  = card && card.querySelector('[class*="author"],[class*="user"],[class*="creator"]');
        const imgEl   = card && card.querySelector('img');
        const descEl  = card && card.querySelector('p,[class*="desc"]');

        results.push({
          id,
          name:        (nameEl && nameEl.textContent.trim()) ||
                       a.textContent.trim().split('\n')[0].trim() ||
                       'Deck ' + id,
          author:      (authEl && authEl.textContent.trim()) || '',
          avatar:      '',
          elements:    [],
          format:      'Constructed',
          description: (descEl && descEl.textContent.trim()) || '',
          cardCount:   0,
          likes:       0,
          views:       0,
          updatedAt:   '',
          thumbnail:   imgEl
                         ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '')
                         : '',
          url: 'https://curiosa.io/decks/' + id
        });
      });

      return results.slice(0, 24);
    });

    await browser2.close();
  }

  if (!decks.length) {
    console.error('No decks found — curiosa.io page structure may have changed.');
    process.exit(1);
  }

  const output = {
    updated: new Date().toISOString(),
    total:   decks.length,
    decks:   decks.slice(0, 24)
  };

  fs.writeFileSync('decks.json', JSON.stringify(output, null, 2));
  console.log(`Done: ${decks.length} decks written to decks.json`);
})();
