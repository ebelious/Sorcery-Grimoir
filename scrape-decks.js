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

  let firstInput = null;
  let firstResp  = null;

  page.on('request', req => {
    const url = req.url();
    if (!url.includes('deck.search')) return;
    try {
      const raw    = new URL(url).searchParams.get('input');
      const parsed = JSON.parse(decodeURIComponent(raw));
      firstInput   = parsed?.['0']?.json || parsed;
      console.log('=== CAPTURED INPUT ===');
      console.log(JSON.stringify(firstInput, null, 2));
    } catch(e) {}
  });

  page.on('response', async response => {
    if (firstResp) return;
    if (!response.url().includes('deck.search')) return;
    try { firstResp = await response.json(); } catch(e) {}
  });

  console.log('Loading page...');
  await page.goto(DECKS_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);

  if (!firstInput || !firstResp) {
    console.error('Did not intercept deck.search');
    await browser.close();
    process.exit(1);
  }

  // Print the FULL first response so we can see every field
  console.log('\n=== FULL FIRST RESPONSE (first 4000 chars) ===');
  const respStr = JSON.stringify(firstResp, null, 2);
  console.log(respStr.slice(0, 4000));

  // Find ALL keys that look like pagination — search entire response tree
  function findAllKeys(obj, path, results) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => findAllKeys(v, `${path}[${i}]`, results));
    } else {
      for (const [k, v] of Object.entries(obj)) {
        const fullPath = path ? `${path}.${k}` : k;
        if (typeof v === 'string' || typeof v === 'number') {
          // Flag anything that could be a cursor or count
          const kl = k.toLowerCase();
          if (kl.includes('cursor') || kl.includes('next') || kl.includes('page') ||
              kl.includes('total') || kl.includes('count') || kl.includes('offset') ||
              kl.includes('skip') || kl.includes('after') || kl.includes('more')) {
            results.push(`${fullPath} = ${v}`);
          }
        } else {
          findAllKeys(v, fullPath, results);
        }
      }
    }
  }

  const paginationKeys = [];
  findAllKeys(firstResp, '', paginationKeys);
  console.log('\n=== PAGINATION-RELATED KEYS IN RESPONSE ===');
  paginationKeys.forEach(k => console.log(k));

  // Count decks in first response
  let deckCount = 0;
  function countDecks(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 14) return;
    if (Array.isArray(obj)) {
      if (obj.length && obj[0]?.id && obj[0]?.name) { deckCount = obj.length; return; }
      obj.forEach(v => countDecks(v, depth+1));
    } else Object.values(obj).forEach(v => countDecks(v, depth+1));
  }
  countDecks(firstResp, 0);
  console.log(`\nDecks in first response: ${deckCount}`);

  // Now try paginating — use page.evaluate so we have browser cookies
  // Try cursor as both string and number
  function findCursor(obj, d) {
    if (!obj || typeof obj !== 'object' || d > 10) return null;
    const keys = ['nextCursor','next_cursor','cursor','endCursor','after','nextPage','next'];
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    for (const v of Object.values(obj)) {
      const r = findCursor(v, d+1);
      if (r !== null) return r;
    }
    return null;
  }

  const firstCursor = findCursor(firstResp, 0);
  console.log(`\nFirst cursor value: ${JSON.stringify(firstCursor)}`);
  console.log(`First cursor type: ${typeof firstCursor}`);

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
    const author = (item.user&&(item.user.username||item.user.displayName||item.user.name))||(item.creator&&(item.creator.username||item.creator.name))||item.author||'';
    const avatar = (item.avatar&&typeof item.avatar==='object'&&(item.avatar.name||item.avatar.cardName))||item.avatarName||'';
    let elements = [];
    if (Array.isArray(item.elements)) elements = item.elements.map(e=>typeof e==='string'?e:(e.name||e.label||'')).filter(Boolean);
    const upd = item.updatedAt||item.updated_at||'';
    return { id:item.id, name:item.name||'Unnamed', author, avatar, elements,
      format:item.format||'Constructed', description:item.description||'',
      cardCount:item.cardCount||(Array.isArray(item.cards)?item.cards.length:0)||0,
      likes:item.likes||item.likesCount||item._count?.likes||0,
      views:item.views||item.viewsCount||item._count?.views||0,
      updatedAt:upd?(()=>{try{return new Date(upd).toISOString().split('T')[0];}catch(e){return '';}})():'',
      thumbnail:getThumb(item), url:'https://curiosa.io/decks/'+item.id };
  }

  const seen = new Set();
  const decks = [];

  function absorb(obj, depth) {
    if (!obj||typeof obj!=='object'||depth>14) return;
    if (Array.isArray(obj)) {
      if (obj.length&&obj[0]?.id&&obj[0]?.name) {
        obj.forEach(item=>{const d=norm(item);if(d&&!seen.has(d.id)){seen.add(d.id);decks.push(d);}});
      } else obj.forEach(v=>absorb(v,depth+1));
    } else Object.values(obj).forEach(v=>absorb(v,depth+1));
  }

  absorb(firstResp, 0);
  console.log(`After page 0: ${decks.length} decks`);

  // Paginate
  let cursor = firstCursor;
  let pageN = 1;

  while (cursor !== null && cursor !== undefined && pageN < 100) {
    // Build input — use exact same shape as first request, just swap cursor
    const inp = { ...firstInput, cursor };
    const url = `${TRPC_URL}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: inp } }))}`;

    try {
      const data = await page.evaluate(async (fetchUrl) => {
        const r = await fetch(fetchUrl, { credentials: 'include', headers: { accept: 'application/json' } });
        if (!r.ok) { console.error('HTTP', r.status); return null; }
        return r.json();
      }, url);

      if (!data) { console.log(`Page ${pageN}: null response`); break; }

      const before = decks.length;
      absorb(data, 0);
      const added = decks.length - before;
      const nc = findCursor(data, 0);

      console.log(`Page ${pageN}: +${added} (total ${decks.length}), cursor=${JSON.stringify(nc)}`);

      // If cursor didn't change or no new decks, stop
      if (added === 0 || nc === cursor || nc === null || nc === undefined) break;
      cursor = nc;
      pageN++;
      await page.waitForTimeout(300);
    } catch(e) {
      console.log(`Page ${pageN} error:`, e.message);
      break;
    }
  }

  await browser.close();

  if (!decks.length) { console.error('No decks.'); process.exit(1); }

  const withThumb = decks.filter(d=>d.thumbnail).length;
  console.log(`\nFinal: ${decks.length} decks, ${withThumb} with thumbnails`);

  decks.forEach(d => {
    d.name = d.name.replace(/\s*\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago.*/i,'')
      .replace(/\s*(Constructed|Draft|Sealed|Limited)\s*@.*/i,'').replace(/\s*@[^\s]+$/,'')
      .replace(/^(Primer|New|Update)\s+/i,'').trim()||d.name;
  });
  decks.sort((a,b)=>(b.views||0)-(a.views||0));

  fs.writeFileSync('decks.json', JSON.stringify({updated:new Date().toISOString(),total:decks.length,decks},null,2));
  console.log('✓ Wrote decks.json');
})();
