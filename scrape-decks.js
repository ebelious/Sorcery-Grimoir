const { chromium } = require('playwright');
const fs = require('fs');

const DECKS_URL = 'https://curiosa.io/decks#search=eyJxdWVyeSI6IiIsInNldCI6IioiLCJmaWx0ZXJzIjpbXSwiY3NvcnQiOiJyZWxldmFuY2UiLCJkc29ydCI6InJlbGV2YW5jZSIsImZzb3J0IjoicmVsZXZhbmNlIiwiZGl2aWRlciI6ImFsbCIsImF2YXRhciI6IioifQ';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Capture everything
  const allRequests  = [];
  const allResponses = [];

  page.on('request', req => allRequests.push({ url: req.url(), method: req.method() }));

  page.on('response', async response => {
    const url = response.url();
    const ct  = response.headers()['content-type'] || '';
    try {
      const text = await response.text();
      if (text.length < 10 || text.length > 20_000_000) return;
      allResponses.push({ url, ct, text });
    } catch(e) {}
  });

  console.log('Loading page...');
  await page.goto(DECKS_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(6000);

  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2500);
  }

  // Extract Algolia credentials from page JS
  const pageHTML = await page.content();
  const algoliaAppId  = (pageHTML.match(/"?applicationId"?\s*[=:]\s*"([A-Z0-9]{8,15})"/i) || pageHTML.match(/appId['":\s]*['"]([A-Z0-9]{8,15})['"]/i) || [])[1];
  const algoliaApiKey = (pageHTML.match(/apiKey['":\s]*['"]([a-f0-9]{20,40})['"]/i) || [])[1];
  const algoliaIndex  = (pageHTML.match(/indexName['":\s]*['"]([^'"]{3,50})['"]/i) || [])[1];

  console.log('Algolia appId:', algoliaAppId);
  console.log('Algolia apiKey:', algoliaApiKey);
  console.log('Algolia index:', algoliaIndex);

  // Also search JS bundle files for Algolia config
  const jsResponses = allResponses.filter(r => r.url.includes('/_next/static/') && r.ct.includes('javascript'));
  for (const jr of jsResponses.slice(0, 20)) {
    const m1 = jr.text.match(/([A-Z0-9]{8,12})['"]\s*,\s*['"](search_only|[a-f0-9]{20,40})['"]/i);
    const m2 = jr.text.match(/algolia[^{]{0,50}{[^}]{0,200}}/i);
    if (m1 || m2) {
      console.log('JS bundle Algolia clue:', jr.url.slice(-60));
      if (m1) console.log('  match1:', m1[0].slice(0,100));
      if (m2) console.log('  match2:', m2[0].slice(0,100));
    }
  }

  const cookies  = await context.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  await browser.close();

  // Print all non-static requests to spot the search API
  console.log('\n=== NON-STATIC REQUESTS ===');
  allRequests
    .filter(r => !r.url.match(/\.(js|css|png|jpg|svg|ico|woff|ttf)(\?|$)/) && !r.url.includes('_next/static'))
    .forEach(r => console.log(r.method, r.url.slice(0, 180)));

  // Print all JSON-ish responses
  console.log('\n=== API RESPONSES ===');
  allResponses
    .filter(r => r.ct.includes('json') || r.url.includes('algolia') || r.url.includes('search') || r.url.includes('api/'))
    .forEach(r => {
      console.log('\n--- ' + r.url.slice(0, 120) + ' ---');
      console.log(r.text.slice(0, 800));
    });

  // Try Algolia if we found credentials
  const decks = [];
  const seen  = new Set();

  if (algoliaAppId && algoliaApiKey) {
    console.log('\n=== Trying Algolia ===');
    const indexName = algoliaIndex || 'decks';
    let page_n = 0;
    while (page_n < 100) {
      const body = JSON.stringify({ query: '', hitsPerPage: 100, page: page_n, attributesToRetrieve: ['*'] });
      const url  = `https://${algoliaAppId}-dsn.algolia.net/1/indexes/${indexName}/query`;
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'X-Algolia-Application-Id': algoliaAppId, 'X-Algolia-API-Key': algoliaApiKey, 'Content-Type': 'application/json' },
          body
        });
        if (!resp.ok) { console.log('Algolia HTTP', resp.status); break; }
        const data = await resp.json();
        if (page_n === 0) {
          console.log('Algolia nbHits:', data.nbHits, 'nbPages:', data.nbPages);
          console.log('Sample hit keys:', data.hits?.[0] ? Object.keys(data.hits[0]).join(', ') : 'none');
          if (data.hits?.[0]) console.log('Sample hit:', JSON.stringify(data.hits[0]).slice(0, 500));
        }
        const hits = data.hits || [];
        hits.forEach(item => {
          const id = item.objectID || item.id;
          if (!id || seen.has(id)) return;
          seen.add(id);
          decks.push({
            id, name: item.name || item.title || 'Unnamed',
            author: item.author || (item.user?.username) || '',
            avatar: item.avatarName || item.avatarCard || (item.avatar?.name) || '',
            elements: Array.isArray(item.elements) ? item.elements : [],
            format: item.format || 'Constructed',
            description: item.description || '',
            cardCount: item.cardCount || 0,
            likes: item.likes || 0, views: item.views || 0,
            updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString().split('T')[0] : '',
            thumbnail: item.thumbnailUrl || item.thumbnail || item.image || item.imageUrl || item.coverImage || item.img || '',
            url: 'https://curiosa.io/decks/' + id
          });
        });
        console.log(`Algolia page ${page_n}: ${hits.length} hits, total so far: ${decks.length}`);
        if (page_n >= (data.nbPages - 1)) break;
        page_n++;
        await new Promise(r => setTimeout(r, 200));
      } catch(e) {
        console.log('Algolia error:', e.message);
        break;
      }
    }
  }

  if (!decks.length) {
    console.error('\nNo decks found. Check the === API RESPONSES === section above for the real endpoint.');
    process.exit(1);
  }

  const withThumb = decks.filter(d => d.thumbnail).length;
  console.log(`\nTotal: ${decks.length} decks, ${withThumb} with thumbnails`);
  decks.sort((a, b) => (b.views || 0) - (a.views || 0));
  fs.writeFileSync('decks.json', JSON.stringify({ updated: new Date().toISOString(), total: decks.length, decks }, null, 2));
  console.log('✓ Wrote decks.json');
})();
