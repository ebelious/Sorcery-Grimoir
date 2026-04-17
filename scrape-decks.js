const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  // ── Phase 1: Intercept the tRPC/API calls on the decks page ─────────────────
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

  const apiCalls = [];
  let tRPCBase   = null;
  let authCookie = '';

  page.on('request', req => {
    const url = req.url();
    if (url.includes('/trpc/')) tRPCBase = url.split('/trpc/')[0] + '/trpc/';
    const cookies = req.headers()['cookie'] || '';
    if (cookies && cookies.length > authCookie.length) authCookie = cookies;
  });

  page.on('response', async response => {
    const url = response.url();
    const ct  = response.headers()['content-type'] || '';
    if (
      ct.includes('application/json') &&
      (url.includes('/trpc/') || url.includes('/api/')) &&
      !url.includes('analytics') && !url.includes('sentry') && !url.includes('clerk')
    ) {
      try { apiCalls.push({ url, json: await response.json() }); } catch (e) {}
    }
  });

  console.log('Loading https://curiosa.io/decks ...');
  await page.goto('https://curiosa.io/decks', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Scroll to trigger more deck loading
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2500);
  }

  // Also try __NEXT_DATA__
  const nextData = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  });

  // Grab cookies for subsequent requests
  const cookies = await page.context().cookies();
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');

  await browser.close();

  // ── Helper: normalise any deck object ─────────────────────────────────────
  function normalise(item) {
    const id = item.id || item.slug || item._id;
    if (!id || typeof id !== 'string' || id.length < 4) return null;

    // Thumbnail — try every possible field name curiosa might use
    const thumbnail =
      item.thumbnailUrl        ||
      item.thumbnail           ||
      item.previewImageUrl     ||
      item.coverImage          ||
      item.image               ||
      item.imageUrl            ||
      item.deckImage           ||
      item.deck_image          ||
      item.preview             ||
      item.previewUrl          ||
      item.bannerUrl           ||
      item.banner              ||
      (item.featuredCard && (
        item.featuredCard.thumbnailUrl || item.featuredCard.imageUrl ||
        item.featuredCard.image        || item.featuredCard.img
      ))  ||
      (item.coverCard && (
        item.coverCard.thumbnailUrl || item.coverCard.imageUrl || item.coverCard.image
      ))  ||
      (item._featuredCard && (item._featuredCard.imageUrl || item._featuredCard.image)) ||
      (item.cards && Array.isArray(item.cards) && item.cards[0] && (
        item.cards[0].thumbnailUrl || item.cards[0].imageUrl
      ))  ||
      '';

    let elements = [];
    if (Array.isArray(item.elements)) {
      elements = item.elements
        .map(e => typeof e === 'string' ? e : (e.name || e.label || e.value || ''))
        .filter(Boolean);
    } else if (typeof item.element === 'string' && item.element) {
      elements = [item.element];
    }

    const author =
      (item.user    && (item.user.username || item.user.displayName || item.user.name)) ||
      (item.creator && (item.creator.username || item.creator.name)) ||
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

  // ── Strategy 1: Walk __NEXT_DATA__ ────────────────────────────────────────
  const seen  = new Set();
  let   decks = [];

  function extractArrays(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 16) return;
    if (Array.isArray(obj)) {
      if (obj.length > 0) {
        const f = obj[0];
        if (f && typeof f === 'object' && (f.id || f.slug) && (f.name || f.title)) {
          console.log(`Found deck array (${obj.length}) in __NEXT_DATA__`);
          obj.forEach(item => {
            const d = normalise(item);
            if (d && !seen.has(d.id)) { seen.add(d.id); decks.push(d); }
          });
        }
      }
      obj.forEach(v => extractArrays(v, depth + 1));
    } else {
      Object.values(obj).forEach(v => extractArrays(v, depth + 1));
    }
  }

  if (nextData) extractArrays(nextData, 0);
  console.log(`After __NEXT_DATA__: ${decks.length} decks`);

  // ── Strategy 2: Intercepted tRPC / REST responses ─────────────────────────
  for (const call of apiCalls) {
    const roots = Array.isArray(call.json) ? call.json : [call.json];
    for (const root of roots) {
      const candidates = [
        root?.result?.data?.decks,
        root?.result?.data?.json?.decks,
        root?.result?.data?.json,
        root?.result?.data,
        root?.data?.decks,
        root?.data?.json?.decks,
        root?.data?.json,
        root?.data,
        root?.decks,
        Array.isArray(root) ? root : null,
      ].filter(v => Array.isArray(v) && v.length > 0);

      for (const arr of candidates) {
        const f = arr[0];
        if (!f || !f.id && !f.slug) continue;
        console.log(`API array (${arr.length}): ${call.url.slice(0, 80)}`);
        arr.forEach(item => {
          const d = normalise(item);
          if (d && !seen.has(d.id)) { seen.add(d.id); decks.push(d); }
        });
      }
    }
  }

  console.log(`After API intercept: ${decks.length} decks`);

  // ── Strategy 3: Try paginating the tRPC deck.list endpoint directly ────────
  if (tRPCBase) {
    console.log('Attempting tRPC pagination via:', tRPCBase);
    let cursor = null;
    let page_n = 0;
    const MAX_PAGES = 20;

    while (page_n < MAX_PAGES) {
      try {
        // Common tRPC batch request shape for curiosa deck listing
        const input = JSON.stringify({ 0: { json: { cursor, limit: 50, orderBy: 'recent' } } });
        const url   = tRPCBase + 'deck.list?batch=1&input=' + encodeURIComponent(input);

        const resp = await fetch(url, {
          headers: { 'cookie': cookieStr, 'accept': 'application/json' }
        }).catch(() => null);

        if (!resp || !resp.ok) break;

        const data = await resp.json().catch(() => null);
        if (!data) break;

        const roots = Array.isArray(data) ? data : [data];
        let found = 0;
        let nextCursor = null;

        for (const root of roots) {
          const inner = root?.result?.data?.json || root?.result?.data || root?.data?.json || root?.data || root;
          const arr   = inner?.decks || inner?.items || (Array.isArray(inner) ? inner : null);
          if (arr && Array.isArray(arr)) {
            arr.forEach(item => {
              const d = normalise(item);
              if (d && !seen.has(d.id)) { seen.add(d.id); decks.push(d); found++; }
            });
            nextCursor = inner?.nextCursor || inner?.cursor || inner?.next || null;
          }
        }

        console.log(`tRPC page ${page_n}: +${found} decks, cursor=${nextCursor}`);
        if (!found || !nextCursor) break;
        cursor = nextCursor;
        page_n++;

        // Be polite
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.log('tRPC pagination error:', e.message);
        break;
      }
    }
  }

  console.log(`After pagination: ${decks.length} decks`);

  // ── Strategy 4: DOM fallback ──────────────────────────────────────────────
  if (!decks.length) {
    console.log('Falling back to DOM scraping...');
    const browser2 = await chromium.launch({ headless: true });
    const page2    = await browser2.newPage();
    await page2.goto('https://curiosa.io/decks', { waitUntil: 'networkidle', timeout: 60000 });

    for (let i = 0; i < 10; i++) {
      await page2.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page2.waitForTimeout(2500);
    }

    const domDecks = await page2.evaluate(() => {
      const results = [], seen2 = new Set();
      document.querySelectorAll('a[href*="/decks/"]').forEach(a => {
        const m = (a.getAttribute('href') || '').match(/\/decks\/([a-zA-Z0-9_-]+)/);
        if (!m) return;
        const id = m[1];
        if (!id || id === 'new' || id === 'import' || seen2.has(id)) return;
        seen2.add(id);

        const c      = a.closest('article,[class*="card"],[class*="deck"],li') || a;
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
          avatar: '', elements: [], format: 'Constructed', description: (descEl && descEl.textContent.trim()) || '',
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
    console.error('No decks found.');
    process.exit(1);
  }

  // Clean names that have metadata concatenated in
  decks = decks.map(d => {
    let name = d.name
      .replace(/\s*\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago.*/i, '')
      .replace(/\s*(Constructed|Draft|Sealed|Limited)\s*@.*/i, '')
      .replace(/\s*@[A-Za-z0-9_\u00C0-\u024F]+$/, '')
      .replace(/^(Primer|New|Update)\s+/i, '')
      .trim() || d.name;
    return { ...d, name };
  });

  // Sort by views descending
  decks.sort((a, b) => (b.views || 0) - (a.views || 0));

  const output = { updated: new Date().toISOString(), total: decks.length, decks };
  fs.writeFileSync('decks.json', JSON.stringify(output, null, 2));
  console.log(`Done: ${decks.length} decks written to decks.json`);
})();
