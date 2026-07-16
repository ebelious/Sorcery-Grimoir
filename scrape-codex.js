const { chromium } = require('playwright');
const fs = require('fs');

const CODEX_URL = 'https://curiosa.io/codex';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // ── Intercept every response that looks codex/FAQ-related ─────────────────
  const rawResponses = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!/codex|faq|glossary|rules/i.test(url)) return;
    try {
      const json = await response.json();
      rawResponses.push(json);
    } catch (e) {}
  });

  function lower(s) { return (s || '').toString().toLowerCase(); }

  // ── Shape detection ─────────────────────────────────────────────────────
  function looksLikeCodex(o) {
    return !!o && typeof o === 'object'
      && (o.k || o.keyword || o.term || o.title || o.name)
      && (o.def !== undefined || o.definition !== undefined || o.text !== undefined || o.content !== undefined || o.description !== undefined);
  }
  function looksLikeFaq(o) {
    return !!o && typeof o === 'object' && (o.q || o.question) && (o.a || o.answer);
  }

  function normCodex(o) {
    const k = o.k || o.keyword || o.term || o.title || o.name || '';
    const def = o.def || o.definition || o.text || o.content || o.description || '';
    if (!k || !def) return null;
    return { k, def, sub: o.sub || o.subDef || '', id: o.id || '' };
  }
  function normFaq(o, cardNameHint) {
    const q = o.q || o.question || '';
    const a = o.a || o.answer || '';
    if (!q || !a) return null;
    const card = o.card || o.cardName || o.cardTitle || cardNameHint || '';
    return { card, q, a, id: o.id || '' };
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
          if (looksLikeCodex(item)) {
            const c = normCodex(item);
            if (c) codexByKey.set(c.id || c.k, c);
          } else if (looksLikeFaq(item)) {
            const f = normFaq(item);
            if (f) faqByKey.set(f.id || (f.card + '|' + f.q), f);
          } else if (item && Array.isArray(item.questions)) {
            // Possible card-grouped shape: { card, questions: [{q,a}, ...] }
            item.questions.forEach(sub => {
              const f = normFaq(sub, item.card || item.name);
              if (f) faqByKey.set(f.id || (f.card + '|' + f.q), f);
            });
          } else if (item && Array.isArray(item.faqs)) {
            item.faqs.forEach(sub => {
              const f = normFaq(sub, item.card || item.name);
              if (f) faqByKey.set(f.id || (f.card + '|' + f.q), f);
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
