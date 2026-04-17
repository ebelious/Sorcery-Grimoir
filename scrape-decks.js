const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // ── Intercept all JSON API / tRPC responses ──────────────────────────────────
  const apiCalls = [];
  page.on('response', async (response) => {
    const url = response.url();
    const ct  = response.headers()['content-type'] || '';
    if (
      ct.includes('application/json') &&
      (url.includes('/api/') || url.includes('/trpc/') || url.includes('curiosa.io')) &&
      !url.includes('analytics') &&
      !url.includes('sentry') &&
      !url.includes('clerk')
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
    timeout: 60000
  });

  // Scroll down to trigger lazy-load / infinite scroll — repeat several times
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2500);
  }

  // ── Try to pull __NEXT_DATA__ from the page (server-side rendered payload) ──
  const nextData = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  });

  // Map from deck-id → thumbnail URL found in the live DOM
  const domThumbs = await page.evaluate(() => {
    const map = {};
    document.querySelectorAll('a[href*="/decks/"]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/\/decks\/([a-zA-Z0-9_-]+)/);
      if (!m) return;
      const id = m[1];
      if (id === 'new' || id === 'import') return;
      const container = a.closest('article,[class*="card"],[class*="deck-item"],[class*="DeckCard"],li,div') || a;
      const img = container.querySelector('img');
      if (img) {
        const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (src && src.startsWith('http')) { map[id] = src; return; }
      }
      const withBg = container.querySelector('[style*="background-image"]');
      if (withBg) {
        const bm = (withBg.getAttribute('style') || '').match(/url\(["']?([^"')]+)["']?\)/);
        if (bm && bm[1].startsWith('http')) map[id] = bm[1];
      }
    });
    return map;
  });

  await browser.close();

  // ── Helper: normalise a single deck item ─────────────────────────────────────
  function normalise(item, thumbMap) {
    const id = item.id || item.slug || item._id;
    if (!id) return null;

    let elements = [];
    if (Array.isArray(item.elements)) {
      elements = item.elements
        .map(e => (typeof e === 'string' ? e : (e.name || e.label || '')))
        .filter(Boolean);
    } else if (typeof item.element === 'string' && item.element) {
      elements = [item.element];
    }

    const thumbnail =
      item.thumbnailUrl     ||
      item.thumbnail        ||
      item.previewImageUrl  ||
      item.coverImage       ||
      item.image            ||
      item.deckImage        ||
      item.imageUrl         ||
      (item.featuredCard  && (item.featuredCard.imageUrl  || item.featuredCard.image))  ||
      (item.coverCard     && (item.coverCard.imageUrl     || item.coverCard.image))     ||
      (item.avatarCard    && item.avatarCard.imageUrl)                                  ||
      (item._featuredCard && item._featuredCard.imageUrl)                               ||
      thumbMap[id]          ||
      '';

    const author =
      (item.user    && (item.user.username || item.user.name || item.user.displayName)) ||
      (item.creator && (item.creator.username || item.creator.name))                    ||
      item.author || item.createdBy || item.username || '';

    const avatar =
      (item.avatar    && (item.avatar.name    || item.avatar.cardName    || item.avatar.title)) ||
      (item.avatarObj && (item.avatarObj.name || item.avatarObj.cardName))                       ||
      item.avatarName || item.avatarCard || '';

    const likes   = item.likes     || item.likesCount  || item.likeCount  || item._count?.likes  || 0;
    const views   = item.views     || item.viewsCount  || item.viewCount  || item._count?.views  || 0;
    const cards   = item.cardCount || item.cards_count ||
                    (Array.isArray(item.cards) ? item.cards.length : 0) || 0;
    const updated = item.updatedAt || item.updated_at || item.lastUpdated || '';

    return {
      id,
      name:        item.name || item.title || 'Unnamed Deck',
      author,
      avatar,
      elements,
      format:      item.format || item.deckFormat || item.type || 'Constructed',
      description: item.description || item.desc || '',
      cardCount:   cards,
      likes,
      views,
      updatedAt:   updated ? new Date(updated).toISOString().split('T')[0] : '',
      thumbnail,
      url: 'https://curiosa.io/decks/' + id
    };
  }

  let decks = [];
  const seen = new Set();

  // ── STRATEGY 1: __NEXT_DATA__ ────────────────────────────────────────────────
  if (nextData) {
    function walk(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 14) return;
      if (Array.isArray(obj)) {
        if (obj.length > 0) {
          const first = obj[0];
          if (first && typeof first === 'object' && (first.id || first.slug) && (first.name || first.title)) {
            console.log(`__NEXT_DATA__: deck array of ${obj.length}`);
            obj.forEach(item => {
              const d = normalise(item, domThumbs);
              if (d && !seen.has(d.id)) { seen.add(d.id); decks.push(d); }
            });
            return;
          }
        }
        obj.forEach(v => walk(v, depth + 1));
      } else {
        Object.values(obj).forEach(v => walk(v, depth + 1));
      }
    }
    walk(nextData, 0);
    console.log(`After __NEXT_DATA__: ${decks.length} decks`);
  }

  // ── STRATEGY 2: Intercepted API / tRPC responses ─────────────────────────────
  for (const call of apiCalls) {
    const root = call.json;
    const roots = Array.isArray(root) ? root : [root];

    for (const r of roots) {
      const candidates = [
        r?.result?.data?.decks,
        r?.result?.data?.json?.decks,
        r?.result?.data?.json,
        r?.result?.data,
        r?.data?.decks,
        r?.data?.json?.decks,
        r?.data?.json,
        r?.data,
        r?.decks,
        Array.isArray(r) ? r : null
      ].filter(v => Array.isArray(v) && v.length > 0);

      for (const arr of candidates) {
        const first = arr[0];
        if (!first || typeof first !== 'object' || (!first.id && !first.slug && !first.name)) continue;
        console.log(`API (${arr.length}): ${call.url.slice(0, 80)}`);
        arr.forEach(item => {
          const d = normalise(item, domThumbs);
          if (d && !seen.has(d.id)) { seen.add(d.id); decks.push(d); }
        });
      }
    }
  }

  console.log(`After API intercept: ${decks.length} decks`);

  // ── STRATEGY 3: DOM fallback ─────────────────────────────────────────────────
  if (!decks.length) {
    console.log('Falling back to DOM scraping...');
    const browser2 = await chromium.launch({ headless: true });
    const page2    = await browser2.newPage();
    await page2.goto('https://curiosa.io/decks', { waitUntil: 'networkidle', timeout: 60000 });
    for (let i = 0; i < 8; i++) {
      await page2.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page2.waitForTimeout(2500);
    }

    const domDecks = await page2.evaluate(() => {
      const results = [];
      const seen2   = new Set();
      document.querySelectorAll('a[href*="/decks/"]').forEach(a => {
        const m = (a.getAttribute('href') || '').match(/\/decks\/([a-zA-Z0-9_-]+)/);
        if (!m) return;
        const id = m[1];
        if (!id || id === 'new' || id === 'import' || seen2.has(id)) return;
        seen2.add(id);

        const c = a.closest('article,[class*="card"],[class*="deck"],li') || a;
        const nameEl = c.querySelector('h2,h3,h4,[class*="name"],[class*="title"]');
        const authEl = c.querySelector('[class*="author"],[class*="user"],[class*="creator"]');
        const imgEl  = c.querySelector('img');
        const descEl = c.querySelector('p,[class*="desc"]');

        let thumb = '';
        if (imgEl) thumb = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
        if (!thumb) {
          const bg = c.querySelector('[style*="background-image"]');
          if (bg) {
            const bm = (bg.getAttribute('style') || '').match(/url\(["']?([^"')]+)["']?\)/);
            if (bm) thumb = bm[1];
          }
        }

        results.push({
          id,
          name:        (nameEl && nameEl.textContent.trim()) || a.textContent.trim().split('\n')[0].trim() || 'Deck ' + id,
          author:      (authEl && authEl.textContent.replace('@','').trim()) || '',
          avatar:      '', elements: [], format: 'Constructed', description: (descEl && descEl.textContent.trim()) || '',
          cardCount: 0, likes: 0, views: 0, updatedAt: '',
          thumbnail: thumb.startsWith('http') ? thumb : '',
          url: 'https://curiosa.io/decks/' + id
        });
      });
      return results;
    });

    await browser2.close();
    domDecks.forEach(d => { if (!seen.has(d.id)) { seen.add(d.id); decks.push(d); } });
    console.log(`After DOM fallback: ${decks.length} decks`);
  }

  if (!decks.length) {
    console.error('No decks found — curiosa.io page structure may have changed.');
    process.exit(1);
  }

  // Clean up names where metadata got concatenated in (e.g. "My Deck2 hours ago")
  decks = decks.map(d => {
    let name = d.name
      .replace(/\s*\d+\s*(minute|hour|day|week|month|year)s?\s*ago.*/i, '')
      .replace(/\s*(Constructed|Draft|Sealed|Limited)\s*@.*/i, '')
      .replace(/\s*@[A-Za-z0-9_]+$/, '')
      .trim() || d.name;
    // Strip leading "Primer" / "New" / "Update" labels if they were prepended
    name = name.replace(/^(Primer|New|Update)\s+/i, '').trim() || name;
    return { ...d, name };
  });

  // Sort by views desc so most popular surface first
  decks.sort((a, b) => (b.views || 0) - (a.views || 0));

  const output = {
    updated: new Date().toISOString(),
    total:   decks.length,
    decks
  };

  fs.writeFileSync('decks.json', JSON.stringify(output, null, 2));
  console.log(`Done: ${decks.length} decks written to decks.json`);
})();
