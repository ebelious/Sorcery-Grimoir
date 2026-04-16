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

  await browser.close();

  if (!articles.length) {
    console.error('No articles found — page may not have rendered correctly');
    process.exit(1);
  }

  const output = {
    updated: new Date().toISOString(),
    articles
  };

  fs.writeFileSync('news.json', JSON.stringify(output, null, 2));
  console.log(`Scraped ${articles.length} articles → news.json`);
})();
