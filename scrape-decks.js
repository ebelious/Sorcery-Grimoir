const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Capture EVERY json response — we'll sort out which ones have decks after
  const allResponses = [];

  page.on('response', async response => {
    const url  = response.url();
    const ct   = (response.headers()['content-type'] || '');
    if (!ct.includes('application/json')) return;
    try {
      const text = await response.text();
      if (text.length < 20 || text.length > 5_000_000) return;
      const json = JSON.parse(text);
      allResponses.push({ url, json });
    } catch (e) {}
  });

  console.log('Loading curiosa.io/decks...');
  await page.goto('https://curiosa.io/decks', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);

  // Scroll repeatedly to trigger infinite scroll / load more
  let prevHeight = 0;
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) break; // no more content loaded
    prevHeight = newHeight;
  }

  // Grab __NEXT_DATA__ which sometimes has everything server-side rendered
  const nextData = await page.evaluate(() => {
    try { return JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null'); }
    catch(e) { return null; }
  });

  // Grab all cookies for subsequent direct API calls
  const cookies  = await context.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Find the tRPC base URL and any cursor tokens from the captured responses
  let tRPCBase = null;
  let seenCursors = new Set();

  for (const { url } of allResponses) {
    if (url.includes('/trpc/')) {
      tRPCBase = url.split('/trpc/')[0] + '/trpc/';
      break;
    }
  }

  await browser.close();

  // ─── Normalise any deck-shaped object ──────────────────────────────────────
  function normalise(item) {
    if (!item || typeof item !== 'object') return null;
    const id = item.id || item.slug || item._id;
    if (!id || typeof id !== 'string' || id.length < 4) return null;

    const thumbnail =
      item.thumbnailUrl     || item.thumbnail      || item.previewImageUrl ||
      item.coverImage       || item.image           || item.imageUrl        ||
      item.deckImage        || item.deck_image      || item.preview         ||
      item.previewUrl       || item.bannerUrl       || item.banner          ||
      item.cover            || item.cardImage       || item.cardImageUrl    ||
      (item.featuredCard && (item.featuredCard.thumbnailUrl || item.featuredCard.imageUrl || item.featuredCard.image || item.featuredCard.img || item.featuredCard.url)) ||
      (item.coverCard    && (item.coverCard.thumbnailUrl    || item.coverCard.imageUrl    || item.coverCard.image)) ||
      (item.avatarCard   && (item.avatarCard.thumbnailUrl   || item.avatarCard.imageUrl   || item.avatarCard.image)) ||
      (item.avatar       && typeof item.avatar === 'object' && (item.avatar.imageUrl || item.avatar.image || item.avatar.thumbnailUrl)) ||
      (item.cards && Array.isArray(item.cards) && item.cards[0] && (item.cards[0].thumbnailUrl || item.cards[0].imageUrl || item.cards[0].image)) ||
      '';

    let elements = [];
    if (Array.isArray(item.elements)) {
      elements = item.elements.map(e => typeof e === 'string' ? e : (e.name || e.label || e.value || '')).filter(Boolean);
    } else if (typeof item.element === 'string' && item.element) {
      elements = [item.element];
    }

    const author =
      (item.user    && (item.user.username || item.user.displayName || item.user.name)) ||
      (item.creator && (item.creator.username || item.creator.name)) ||
      item.author || item.createdBy || item.username || '';

    const avatarName =
      (typeof item.avatar === 'object' && item.avatar && (item.avatar.name || item.avatar.cardName || item.avatar.title)) ||
      (item.avatarObj && (item.avatarObj.name || item.avatarObj.cardName)) ||
      (typeof item.avatar === 'string' ? item.avatar : '') ||
      item.avatarName || item.avatarCard || '';

    return {
      id,
      name:        item.name || item.title || 'Unnamed Deck',
      author,
      avatar:      avatarName,
      elements,
      format:      item.format || item.deckFormat || item.type || 'Constructed',
      description: item.description || item.desc || '',
      cardCount:   item.cardCount || item.cards_count || (Array.isArray(item.cards) ? item.cards.length : 0) || 0,
      likes:       item.likes || item.likesCount || item.likeCount || item._count?.likes || 0,
      views:       item.views || item.viewsCount || item.viewCount || item._count?.views || 0,
      updatedAt:   (() => { const u = item.updatedAt || item.updated_at || item.lastUpdated || ''; try { return u ? new Date(u).toISOString().split('T')[0] : ''; } catch(e) { return ''; } })(),
      thumbnail,
      url: 'https://curiosa.io/decks/' + id
    };
  }

  const seen  = new Set();
  const decks = [];

  function absorb(arr, source) {
    if (!Array.isArray(arr) || !arr.length) return 0;
    const first = arr[0];
    if (!first || typeof first !== 'object') return 0;
    if (!first.id && !first.slug && !first.name && !first.title) return 0;
    let added = 0;
    arr.forEach(item => {
      const d = normalise(item);
      if (d && !seen.has(d.id)) { seen.add(d.id); decks.push(d); added++; }
    });
    if (added) console.log(`  +${added} decks from ${source}`);
    return added;
  }

  function walkObject(obj, depth, source) {
    if (!obj || typeof obj !== 'object' || depth > 16) return;
    if (Array.isArray(obj)) {
      absorb(obj, source);
      obj.forEach(v => walkObject(v, depth + 1, source));
    } else {
      Object.values(obj).forEach(v => walkObject(v, depth + 1, source));
    }
  }

  // ── 1. __NEXT_DATA__ ────────────────────────────────────────────────────────
  if (nextData) {
    console.log('Walking __NEXT_DATA__...');
    walkObject(nextData, 0, '__NEXT_DATA__');
  }

  // ── 2. Intercepted responses ─────────────────────────────────────────────
  console.log(`Processing ${allResponses.length} intercepted JSON responses...`);
  for (const { url, json } of allResponses) {
    walkObject(json, 0, url.slice(0, 60));
  }

  console.log(`After initial scrape: ${decks.length} decks`);

  // ── 3. Direct tRPC pagination ─────────────────────────────────────────────
  // Try every plausible procedure name curiosa might use
  const procedureNames = [
    'deck.getAll', 'deck.list', 'deck.getPublic', 'deck.getRecent',
    'decks.getAll', 'decks.list', 'decks.getPublic',
    'getDecks', 'listDecks', 'publicDecks',
    'deck.feed', 'deck.browse', 'deck.community',
  ];

  if (tRPCBase) {
    console.log('tRPC base:', tRPCBase);

    for (const proc of procedureNames) {
      let cursor = undefined;
      let pageNum = 0;
      let procWorked = false;

      while (pageNum < 30) {
        try {
          const inputObj = { limit: 50, ...(cursor !== undefined ? { cursor } : {}) };
          const batchInput = JSON.stringify({ 0: { json: inputObj } });
          const url = `${tRPCBase}${proc}?batch=1&input=${encodeURIComponent(batchInput)}`;

          const resp = await fetch(url, {
            headers: { 'cookie': cookieStr, 'accept': 'application/json', 'content-type': 'application/json' }
          });

          if (!resp.ok) break;

          const data = await resp.json();
          const roots = Array.isArray(data) ? data : [data];
          let pageDecks = 0;
          let nextCursor = null;

          for (const root of roots) {
            // Walk every level to find deck arrays AND next cursor
            const inner =
              root?.result?.data?.json ||
              root?.result?.data      ||
              root?.data?.json        ||
              root?.data              ||
              root;

            // Find arrays of decks
            const candidates = [
              inner?.decks, inner?.items, inner?.data,
              inner?.result, inner?.nodes,
              Array.isArray(inner) ? inner : null
            ].filter(v => Array.isArray(v) && v.length > 0);

            for (const arr of candidates) {
              pageDecks += absorb(arr, `${proc} p${pageNum}`);
            }

            // Find next cursor
            nextCursor =
              inner?.nextCursor || inner?.next_cursor || inner?.cursor ||
              inner?.pageInfo?.endCursor || inner?.meta?.nextCursor ||
              inner?.pagination?.cursor || null;
          }

          if (pageDecks > 0) procWorked = true;
          if (!procWorked && pageNum === 0) break; // this proc does nothing
          if (!nextCursor || pageDecks === 0) break;

          cursor = nextCursor;
          pageNum++;
          await new Promise(r => setTimeout(r, 300));

        } catch (e) {
          break;
        }
      }

      if (procWorked) {
        console.log(`Procedure '${proc}' worked, total now: ${decks.length}`);
        break; // found the right one
      }
    }
  } else {
    console.log('No tRPC base URL detected — trying common paths...');
    const commonBases = [
      'https://curiosa.io/api/trpc/',
      'https://api.curiosa.io/trpc/',
      'https://curiosa.io/trpc/',
    ];
    for (const base of commonBases) {
      try {
        const test = await fetch(`${base}deck.list?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: { limit: 10 } } }))}`, {
          headers: { 'accept': 'application/json' }
        });
        if (test.ok) {
          tRPCBase = base;
          console.log('Found tRPC at:', base);
          break;
        }
      } catch(e) {}
    }
  }

  console.log(`Total after all strategies: ${decks.length} decks`);

  if (!decks.length) {
    console.error('No decks found — curiosa.io may have changed its API or requires auth.');
    process.exit(1);
  }

  // Clean up concatenated metadata in names
  const cleaned = decks.map(d => ({
    ...d,
    name: d.name
      .replace(/\s*\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago.*/i, '')
      .replace(/\s*(Constructed|Draft|Sealed|Limited)\s*@.*/i, '')
      .replace(/\s*@[A-Za-z0-9_\u00C0-\u024F\u00F8-\u00FF]+$/, '')
      .replace(/^(Primer|New|Update)\s+/i, '')
      .trim() || d.name
  }));

  cleaned.sort((a, b) => (b.views || 0) - (a.views || 0));

  fs.writeFileSync('decks.json', JSON.stringify({ updated: new Date().toISOString(), total: cleaned.length, decks: cleaned }, null, 2));
  console.log(`✓ Wrote ${cleaned.length} decks to decks.json`);
})();
