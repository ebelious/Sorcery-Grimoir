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
    // Known non-reward UI text to skip (nav, filters, headers, etc.)
    const SKIP = new Set([
      'Events', 'Rewards', 'Login', 'Reward Store', 'Catalogue:', 'Filters',
      'Tags', 'Min', 'Max', 'TagsMinMax', 'Point Amount', 'Powered By',
      'Give us a Follow!', 'Links', 'Policies', 'Sold Out'
    ]);
    const NUM_RE = /^[\d,]+$/;

    // Images that are clearly site chrome, not reward art -- exclude these
    // from both the direct lookup and the positional fallback below.
    const NON_REWARD_IMG_RE = /sorcery_logo|cardeio-logo|brand\/|dust/i;
    // Confirmed real reward-image CDN pattern (e.g.
    // https://storage.googleapis.com/cardeio-images/sorcery/rewards/promo_arthurian_legends_foot_soldier_pack.webp)
    // -- used to prefer high-confidence matches when multiple candidates exist.
    const REWARD_IMG_RE = /cardeio-images\/sorcery\/rewards\//i;
    const catalogueImgs = Array.from(document.querySelectorAll('img')).filter(img => {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      return src && !NON_REWARD_IMG_RE.test(src);
    });
    // For the positional fallback, prefer confirmed-pattern images if there
    // are enough of them; otherwise fall back to the broader candidate list.
    const confirmedImgs = catalogueImgs.filter(img => {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      return REWARD_IMG_RE.test(src);
    });

    function findImageForName(nameLine) {
      // Broaden beyond exact-leaf-node matching: any element whose full
      // (possibly nested) text content equals the name, walking up several
      // ancestor levels looking for the nearest <img>. Among any images
      // found, prefer ones matching the confirmed reward-image CDN pattern.
      const candidates = Array.from(document.querySelectorAll('body *')).filter(
        el => el.textContent && el.textContent.trim() === nameLine && el.children.length <= 2
      );
      let fallback = '';
      for (const start of candidates) {
        let node = start;
        for (let depth = 0; depth < 6 && node; depth++) {
          const img = node.querySelector ? node.querySelector('img') : null;
          if (img) {
            const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
            if (src && !NON_REWARD_IMG_RE.test(src)) {
              if (REWARD_IMG_RE.test(src)) return src; // high confidence, use immediately
              if (!fallback) fallback = src;
            }
          }
          node = node.parentElement;
        }
      }
      return fallback;
    }

    const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];

    for (let i = 0; i < lines.length; i++) {
      const nameLine = lines[i];
      const nextLine = lines[i + 1];
      if (SKIP.has(nameLine) || NUM_RE.test(nameLine)) continue;
      if (!nextLine || !NUM_RE.test(nextLine)) continue;
      // nameLine is immediately followed by a bare number -- treat as a
      // reward: name + points cost.
      const points = parseInt(nextLine.replace(/,/g, ''), 10);
      const soldOut = lines[i + 2] === 'Sold Out';

      let image = findImageForName(nameLine);
      let url = '';
      const nameEls = Array.from(document.querySelectorAll('body *')).filter(
        el => el.children.length === 0 && el.innerText && el.innerText.trim() === nameLine
      );
      if (nameEls.length) {
        const card = nameEls[0].closest('[class]') || nameEls[0];
        const link = card.tagName === 'A' ? card : card.closest('a[href]') || card.querySelector('a[href]');
        if (link) {
          const href = link.getAttribute('href');
          if (href) url = href.startsWith('http') ? href : 'https://play.sorcerytcg.com' + href;
        }
      }

      results.push({ name: nameLine, points, soldOut, image, url });
      i += soldOut ? 2 : 1; // skip past the consumed points (and "Sold Out") line(s)
    }

    // Positional fallback: if a reward still has no image but the number of
    // catalogue images lines up closely with the number of rewards found,
    // assume DOM order matches display order and pair them by index. Prefer
    // the confirmed-CDN-pattern image list when it's plausible (close to the
    // reward count); otherwise fall back to the broader candidate list.
    const missingCount = results.filter(r => !r.image).length;
    const fallbackImgs = Math.abs(confirmedImgs.length - results.length) <= 3 ? confirmedImgs : catalogueImgs;
    if (missingCount && Math.abs(fallbackImgs.length - results.length) <= 3) {
      results.forEach((r, idx) => {
        if (!r.image && fallbackImgs[idx]) {
          r.image = fallbackImgs[idx].getAttribute('src') || fallbackImgs[idx].getAttribute('data-src') || '';
        }
      });
    }

    return {
      rewards: results.slice(0, 300),
      diagnostics: {
        totalLines: lines.length,
        rewardsParsed: results.length,
        catalogueImagesFound: catalogueImgs.length,
        confirmedPatternImagesFound: confirmedImgs.length,
        rewardsWithImage: results.filter(r => r.image).length,
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
