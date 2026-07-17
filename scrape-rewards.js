// Scrapes the Sorcery Play Network Reward Store catalogue
// (https://play.sorcerytcg.com/rewards), powered by Carde.io.
//
// Same situation as scrape-events.js: this is a client-rendered SPA with no
// documented public API, so this uses Playwright to load the page and read
// the rendered DOM. The catalogue has a "Point Amount" filter, suggesting
// each reward is redeemable for a certain number of points.
//
// NOTE: I couldn't inspect the live rendered page's exact DOM/class names
// (no browser access in the environment this was written in), so the
// selectors below are a best-effort guess. If this comes back with 0
// rewards, check the workflow's logs -- diagnostic output below shows what
// was actually found on the page, which is the fastest way to tell me what
// to fix.

const { chromium } = require('playwright');
const fs = require('fs');

const REWARDS_URL = 'https://play.sorcerytcg.com/rewards';

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Fetching ' + REWARDS_URL + '...');
  await page.goto(REWARDS_URL, {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  await page.waitForTimeout(3000);
  // Reward items are likely cards with an image and a point cost; try a few
  // reasonable selector guesses for "something that looks like a catalogue
  // item" before falling back to just scanning for point-amount text.
  await page.waitForSelector('img', { timeout: 15000 }).catch(() => {});

  const { rewards, diagnostics } = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Reward catalogue items typically show an image, a name, and a point
    // cost (e.g. "5,000 pts" or "5,000 Points"). Find text nodes matching a
    // point-amount pattern and walk up to the nearest card-like container.
    const pointPattern = /([\d,]{3,})\s*(pts?|points?)\b/i;
    const allEls = Array.from(document.querySelectorAll('body *'));
    const pointEls = allEls.filter(el =>
      el.children.length === 0 && pointPattern.test(el.innerText || '')
    );

    pointEls.forEach(el => {
      const card = el.closest('[class]') || el;
      if (seen.has(card)) return;
      seen.add(card);

      const fullText = (card.innerText || '').trim();
      if (!fullText) return;

      const pointsMatch = fullText.match(pointPattern);
      const points = pointsMatch ? parseInt(pointsMatch[1].replace(/,/g, ''), 10) : null;

      const heading = card.querySelector('h1,h2,h3,h4,h5,strong');
      const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
      const name = (heading ? heading.innerText.trim() : '') || lines.find(l => !pointPattern.test(l)) || '';
      if (!name) return;

      const img = card.querySelector('img');
      const image = img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '';

      const link = card.tagName === 'A' ? card : card.querySelector('a[href]');
      const href = link ? link.getAttribute('href') : '';
      const url = href ? (href.startsWith('http') ? href : 'https://play.sorcerytcg.com' + href) : '';

      results.push({ name, points, image, url });
    });

    return {
      rewards: results.slice(0, 200),
      diagnostics: {
        pointTextElementsFound: pointEls.length,
        bodyTextSample: document.body.innerText.slice(0, 500)
      }
    };
  });

  console.log('Diagnostics:', JSON.stringify(diagnostics, null, 2));

  await browser.close();

  if (!rewards.length) {
    console.error('No rewards found -- page may not have rendered correctly, or selectors need updating. See diagnostics above.');
    fs.writeFileSync('rewards.json', JSON.stringify({ updated: new Date().toISOString(), rewards: [] }, null, 2));
    process.exit(1);
  }

  const output = {
    updated: new Date().toISOString(),
    source: REWARDS_URL,
    rewards
  };

  fs.writeFileSync('rewards.json', JSON.stringify(output, null, 2));
  console.log('Done -- scraped ' + rewards.length + ' rewards to rewards.json');
})();
