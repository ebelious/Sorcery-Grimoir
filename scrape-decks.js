const { chromium } = require('playwright');
const fs = require('fs');

// The full decks browse URL with search params decoded from the hash
const DECKS_URL = 'https://curiosa.io/decks#search=eyJxdWVyeSI6IiIsInNldCI6IioiLCJmaWx0ZXJzIjpbXSwiY3NvcnQiOiJyZWxldmFuY2UiLCJkc29ydCI6InJlbGV2YW5jZSIsImZzb3J0IjoicmVsZXZhbmNlIiwiZGl2aWRlciI6ImFsbCIsImF2YXRhciI6IioifQ';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Log ALL json responses with their full URLs so we can see what API is used
  const allResponses = [];
  page.on('response', async response => {
    const url = response.url();
    const ct  = response.headers()['content-type'] || '';
    if (!ct.includes('application/json') && !ct.includes('text/plain')) return;
    try {
      const text = await response.text();
      if (text.length < 10 || text.length > 10_000_000) return;
      const json = JSON.parse(text);
      allResponses.push({ url, json });
      // Log interesting ones
      if (url.includes('algolia') || url.includes('search') || url.includes('deck') || url.includes('trpc')) {
        console.log('RESPONSE:', url.slice(0, 120));
      }
    } catch (e) {}
  });

  console.log('Loading:', DECKS_URL);
  await page.goto(DECKS_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Scroll to trigger loading
  let prev = 0;
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === prev && i > 2) break;
    prev = h;
  }

  const nextData = await page.evaluate(() => {
    try { return JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null'); }
    catch(e) { return null; }
  });

  // Print ALL unique API URLs we saw
  console.log('\n=== ALL JSON API URLS ===');
  const uniqueUrls = [...new Set(allResponses.map(r => r.url))];
  uniqueUrls.forEach(u => console.log(u));
  console.log('=========================\n');

  await browser.close();

  function normalise(item) {
    if (!item || typeof item !== 'object') return null;
    const id = item.id || item.slug || item.objectID;
    if (!id || typeof id !== 'string' || id.length < 4) return null;

    const thumbnail =
      item.thumbnailUrl || item.thumbnail || item.previewImageUrl ||
      item.coverImage   || item.image     || item.imageUrl        ||
      item.deckImage    || item.preview   || item.bannerUrl       ||
      item.cover        || item.cardImage || item['thumbnail_url']||
      item['image_url'] || item.img       || item.photo          ||
      (item.featuredCard  && (item.featuredCard.thumbnailUrl  || item.featuredCard.imageUrl  || item.featuredCard.image)) ||
      (item.coverCard     && (item.coverCard.thumbnailUrl     || item.coverCard.imageUrl     || item.coverCard.image))    ||
      (item.avatarCard    && typeof item.avatarCard === 'object' && (item.avatarCard.imageUrl || item.avatarCard.image))  ||
      (item.avatar && typeof item.avatar === 'object' && (item.avatar.imageUrl || item.avatar.image || item.avatar.thumbnailUrl)) ||
      '';

    let elements = [];
    if (Array.isArray(item.elements)) {
      elements = item.elements.map(e => typeof e === 'string' ? e : (e.name || e.label || '')).filter(Boolean);
    }

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
      format: item.format || item.deckFormat || 'Constructed',
      description: item.description || '',
      cardCount: item.cardCount || (Array.isArray(item.cards) ? item.cards.length : 0) || 0,
      likes: item.likes || item.likesCount || item._count?.likes || 0,
      views: item.views || item.viewsCount || item._count?.views || 0,
      updatedAt: updated ? (() => { try { return new Date(updated).toISOString().split('T')[0]; } catch(e) { return ''; } })() : '',
      thumbnail,
      url: 'https://curiosa.io/decks/' + id
    };
  }

  const seen  = new Set();
  const decks = [];

  function absorb(arr, src) {
    if (!Array.isArray(arr) || !arr.length) return 0;
    const f = arr[0];
    if (!f || typeof f !== 'object' || (!f.id && !f.slug && !f.objectID)) return 0;
    let n = 0;
    arr.forEach(item => {
      const d = normalise(item);
      if (d && !seen.has(d.id)) { seen.add(d.id); decks.push(d); n++; }
    });
    if (n) console.log(`  +${n} from ${src}`);
    return n;
  }

  function walkAll(obj, depth, src) {
    if (!obj || typeof obj !== 'object' || depth > 14) return;
    if (Array.isArray(obj)) { absorb(obj, src); obj.forEach(v => walkAll(v, depth+1, src)); }
    else Object.values(obj).forEach(v => walkAll(v, depth+1, src));
  }

  if (nextData) walkAll(nextData, 0, '__NEXT_DATA__');

  for (const { url, json } of allResponses) {
    walkAll(json, 0, url.replace('https://','').slice(0,60));
  }

  // Also check for Algolia hits format specifically
  for (const { url, json } of allResponses) {
    if (json?.results && Array.isArray(json.results)) {
      json.results.forEach((r, i) => {
        if (r?.hits) absorb(r.hits, `algolia[${i}]`);
      });
    }
    if (json?.hits) absorb(json.hits, 'algolia.hits');
  }

  console.log(`Total: ${decks.length} decks`);

  if (!decks.length) {
    console.error('No decks found. Check the URL list above to identify the real API endpoint.');
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
