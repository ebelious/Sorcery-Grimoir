const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Fetching https://sorcerytcg.com/news...');
  await page.goto('https://sorcerytcg.com/news', {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  // Wait for article links to appear
  await page.waitForSelector('a[href^="/news/"]', { timeout: 15000 }).catch(() => {});

  const articles = await page.evaluate(() => {
    const seen = new Set();
    const results = [];

    document.querySelectorAll('a[href^="/news/"]').forEach(a => {
      const href = a.getAttribute('href');
      const url = 'https://sorcerytcg.com' + href;

      // Skip non-article links (nav, footer, etc.)
      const slug = href.replace('/news/', '');
      if (!slug || slug.length < 5 || seen.has(url)) return;
      seen.add(url);

      // Try to find a title — use link text, or nearest heading, or format slug
      let title = '';
      const heading = a.querySelector('h1,h2,h3,h4,p');
      if (heading) {
        title = heading.innerText.trim();
      } else {
        title = a.innerText.trim();
      }
      // If still no title, format the slug
      if (!title || title.length < 4) {
        title = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      }

      // Try to find a date near the link
      let date = '';
      const parent = a.closest('article,section,div,[class]');
      if (parent) {
        const timeEl = parent.querySelector('time');
        if (timeEl) date = timeEl.innerText.trim() || timeEl.getAttribute('datetime') || '';
      }

      results.push({ title, url, date, source: 'sorcerytcg.com' });
    });

    return results.slice(0, 25);
  });

  if (!articles.length) {
    await browser.close();
    console.error('No articles found — page may not have rendered correctly');
    process.exit(1);
  }

  // Load existing news.json to skip re-fetching images for articles we already have
  let existingImages = {};
  try {
    const existing = JSON.parse(fs.readFileSync('news.json', 'utf8'));
    (existing.articles || []).forEach(a => {
      if (a.url && a.image) existingImages[a.url] = a.image;
    });
    console.log(`Loaded ${Object.keys(existingImages).length} cached images from existing news.json`);
  } catch (e) {
    console.log('No existing news.json found, will fetch all images fresh');
  }

  // Fetch OG image for each article (skip if already cached)
  console.log('Fetching OG images for articles...');
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];

    if (existingImages[article.url]) {
      article.image = existingImages[article.url];
      console.log(`[${i + 1}/${articles.length}] cached  ${article.url}`);
      continue;
    }

    try {
      const articlePage = await browser.newPage();
      await articlePage.goto(article.url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });

      const ogImage = await articlePage.$eval(
        'meta[property="og:image"]',
        el => el.getAttribute('content')
      ).catch(() => null);

      if (ogImage) {
        // Make sure it's an absolute URL
        article.image = ogImage.startsWith('http') ? ogImage : 'https://sorcerytcg.com' + ogImage;
        console.log(`[${i + 1}/${articles.length}] found   ${article.url} → ${article.image}`);
      } else {
        console.log(`[${i + 1}/${articles.length}] no img  ${article.url}`);
      }

      await articlePage.close();
    } catch (e) {
      console.log(`[${i + 1}/${articles.length}] failed  ${article.url} — ${e.message}`);
    }
  }

  await browser.close();

  const output = {
    updated: new Date().toISOString(),
    articles
  };

  fs.writeFileSync('news.json', JSON.stringify(output, null, 2));
  console.log(`Done — scraped ${articles.length} articles → news.json`);
})();
