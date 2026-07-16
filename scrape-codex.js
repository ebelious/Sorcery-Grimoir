const { chromium } = require('playwright');
const fs = require('fs');

const CODEX_URL = 'https://curiosa.io/codex';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // ── Intercept every response that could carry codex/FAQ data ──────────────
  // Confirmed the backend is Sanity CMS (fields like _id/_type/_createdAt),
  // whose generic query API domain (sanity.io / apicdn.sanity.io) won't
  // necessarily have "codex" or "faq" in the URL itself — only in the GROQ
  // query text — so match on that domain too, not just keyword URLs.
  const rawResponses = [];
  const rawUrls = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!/codex|faq|glossary|rules|sanity/i.test(url)) return;
    try {
      const json = await response.json();
      rawResponses.push(json);
      rawUrls.push(url);
    } catch (e) {}
  });

  function lower(s) { return (s || '').toString().toLowerCase(); }

  // Sanity stores rich text as "Portable Text": an array of block objects,
  // each with a `children` array of spans carrying the actual `text`.
  function portableTextToPlain(val) {
    if (typeof val === 'string') return val.trim();
    if (!Array.isArray(val)) return '';
    return val.map(block => {
      if (!block) return '';
      if (typeof block === 'string') return block;
      if (Array.isArray(block.children)) {
        return block.children.map(c => (c && c.text) || '').join('');
      }
      return block.text || '';
    }).join('\n').trim();
  }

  // ── Shape detection ─────────────────────────────────────────────────────
  function looksLikeCodex(o) {
    if (!o || typeof o !== 'object') return false;
    if (o._type && /codex|glossary|term|keyword/i.test(o._type)) return true;
    return !!(o.k || o.keyword || o.term || o.title || o.name)
      && (o.def !== undefined || o.definition !== undefined || o.text !== undefined || o.content !== undefined || o.description !== undefined);
  }
  function looksLikeFaq(o) {
    if (!o || typeof o !== 'object') return false;
    if (o._type && /faq/i.test(o._type)) return true;
    return !!(o.q || o.question) && !!(o.a || o.answer);
  }

  function normCodex(o) {
    const k = portableTextToPlain(o.k || o.keyword || o.term || o.title || o.name);
    const def = portableTextToPlain(o.def || o.definition || o.text || o.content || o.description);
    if (!k || !def) return null;
    return { k, def, sub: portableTextToPlain(o.sub || o.subDef) || '', id: o._id || o.id || '' };
  }

  // Returns an array — a Sanity FAQ entry can apply to multiple cards via
  // cardNames, and the app's schema expects one { card, q, a } row per card.
  function normFaq(o, cardNameHint) {
    const qText = portableTextToPlain(o.q || o.question);
    const aText = portableTextToPlain(o.a || o.answer);
    if (!qText || !aText) return [];
    let names = [];
    if (Array.isArray(o.cardNames) && o.cardNames.length) names = o.cardNames;
    else if (Array.isArray(o.cards) && o.cards.length) names = o.cards;
    else if (o.card || o.cardName || o.cardTitle) names = [o.card || o.cardName || o.cardTitle];
    else if (cardNameHint) names = [cardNameHint];
    else names = [''];
    const id = o._id || o.id || '';
    return names.map(nm => ({ card: nm || '', q: qText, a: aText, id: id }));
  }

  var _loggedSample = false;
  const codexByKey = new Map();
  const faqByKey = new Map();

  function absorb(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 16) return;
    if (Array.isArray(obj)) {
      if (obj.length && (looksLikeCodex(obj[0]) || looksLikeFaq(obj[0]))) {
        if (!_loggedSample) {
          _loggedSample = true;
          console.log('Sample raw codex/FAQ object (for debugging field mapping):');
          console.log(JSON.stringify(obj[0], null, 2));
        }
        obj.forEach(item => {
          if (looksLikeFaq(item)) {
            normFaq(item).forEach(f => faqByKey.set((f.id ? f.id + '|' : '') + f.card + '|' + f.q, f));
          } else if (looksLikeCodex(item)) {
            const c = normCodex(item);
            if (c) codexByKey.set(c.id || c.k, c);
          } else if (item && Array.isArray(item.questions)) {
            // Possible card-grouped shape: { card, questions: [{q,a}, ...] }
            item.questions.forEach(sub => {
              normFaq(sub, item.card || item.name).forEach(f => faqByKey.set((f.id ? f.id + '|' : '') + f.card + '|' + f.q, f));
            });
          } else if (item && Array.isArray(item.faqs)) {
            item.faqs.forEach(sub => {
              normFaq(sub, item.card || item.name).forEach(f => faqByKey.set((f.id ? f.id + '|' : '') + f.card + '|' + f.q, f));
            });
          }
        });
      } else {
        obj.forEach(v => absorb(v, depth + 1));
      }
    } else {
      Object.values(obj).forEach(v => absorb(v, depth + 1));
    }
  }

  // ── Load page and scroll to trigger all lazy loads ────────────────────────
  console.log('Loading codex page...');
  await page.goto(CODEX_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  console.log(`After initial load: ${rawResponses.length} response(s) intercepted`);

  let scrollRounds = 0;
  let lastCount    = 0;
  let staleRounds  = 0;

  while (scrollRounds < 100 && staleRounds < 6) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const el = document.querySelector('main, [role="main"], .codex-list, #codex-list');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(600);

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
  console.log('Intercepted URLs:');
  rawUrls.forEach((u, i) => console.log(`  [${i}] ${u}`));

  for (const resp of rawResponses) {
    absorb(resp, 0);
  }

  const codex = Array.from(codexByKey.values());
  const faq = Array.from(faqByKey.values());
  console.log(`Codex entries: ${codex.length}`);
  console.log(`FAQ entries: ${faq.length}`);

  await browser.close();

  if (!codex.length && !faq.length) {
    console.error('No codex or FAQ entries scraped.');
    process.exit(1);
  }

  codex.sort((a, b) => a.k.localeCompare(b.k));

  fs.writeFileSync(
    'codex.json',
    JSON.stringify({ updated: new Date().toISOString(), codex, faq }, null, 2)
  );
  console.log('✓ Wrote codex.json');
})();
