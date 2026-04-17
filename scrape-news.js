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

  await page.waitForSelector('a[href^="/news/"]', { timeout: 15000 }).catch(() => {});

  const articles = await page.evaluate(() => {
    const seen = new Set();
    const results = [];

    document.querySelectorAll('a[href^="/news/"]').forEach(a => {
      const href = a.getAttribute('href');
      const url = 'https://sorcerytcg.com' + href;

      const slug = href.replace('/news/', '');
      if (!slug || slug.length < 5 || seen.has(url)) return;
      seen.add(url);

      let title = '';
      const heading = a.querySelector('h1,h2,h3,h4,p');
      if (heading) {
        title = heading.innerText.trim();
      } else {
        title = a.innerText.trim();
      }
      if (!title || title.length < 4) {
        title = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      }

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
    console.error('No articles found -- page may not have rendered correctly');
    process.exit(1);
  }

  // Load existing news.json to avoid re-fetching images we already have
  let existingImages = {};
  try {
    const existing = JSON.parse(fs.readFileSync('news.json', 'utf8'));
    (existing.articles || []).forEach(a => {
      if (a.url && a.image) existingImages[a.url] = a.image;
    });
    console.log('Loaded ' + Object.keys(existingImages).length + ' cached images from existing news.json');
  } catch (e) {
    console.log('No existing news.json found, will fetch all images fresh');
  }

  // Fetch cover image for each article
  console.log('Fetching images for articles...');
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];

    if (existingImages[article.url]) {
      article.image = existingImages[article.url];
      console.log('[' + (i + 1) + '/' + articles.length + '] cached  ' + article.url);
      continue;
    }

    try {
      const articlePage = await browser.newPage();
      await articlePage.goto(article.url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });

      // Try og:image first, then fall back to first img in main content
      let rawImage = await articlePage.$eval(
        'meta[property="og:image"]',
        el => el.getAttribute('content')
      ).catch(() => null);

      if (!rawImage) {
        rawImage = await articlePage.$eval(
          'main img[src], article img[src], img[src*="sanity"]',
          el => el.getAttribute('src')
        ).catch(() => null);
      }

      if (rawImage) {
        let finalImage = rawImage.startsWith('http')
          ? rawImage
          : 'https://sorcerytcg.com' + rawImage;

        // sorcerytcg.com wraps all images in Next.js image optimizer:
        //   /_next/image?url=https%3A%2F%2Fcdn.sanity.io%2F...&w=3840&q=75
        // This wrapper is same-origin only and fails cross-origin in the app.
        // Decode the inner `url` param to get the real Sanity CDN URL directly.
        try {
          const parsed = new URL(finalImage);
          const inner = parsed.searchParams.get('url');
          if (inner) finalImage = decodeURIComponent(inner);
        } catch (e) {}

        article.image = finalImage;
        console.log('[' + (i + 1) + '/' + articles.length + '] found   ' + article.url);
      } else {
        console.log('[' + (i + 1) + '/' + articles.length + '] no img  ' + article.url);
      }

      await articlePage.close();
    } catch (e) {
      console.log('[' + (i + 1) + '/' + articles.length + '] failed  ' + article.url + ' -- ' + e.message);
    }
  }

  await browser.close();

  const output = {
    updated: new Date().toISOString(),
    articles
  };

  fs.writeFileSync('news.json', JSON.stringify(output, null, 2));
  console.log('Done -- scraped ' + articles.length + ' articles to news.json');
})();
