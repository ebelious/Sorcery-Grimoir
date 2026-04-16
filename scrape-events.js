const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Fetching https://play.sorcerytcg.com/events...');
  await page.goto('https://play.sorcerytcg.com/events', {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  // Wait for events to render
  await page.waitForTimeout(3000);

  const events = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Try common event card selectors
    const cards = document.querySelectorAll(
      '[class*="event"], [class*="Event"], article, .card, [class*="card"]'
    );

    cards.forEach(card => {
      const text = card.innerText || '';
      if (!text.trim() || text.length < 10) return;

      // Extract name — look for heading or first strong text
      const nameEl = card.querySelector('h1,h2,h3,h4,strong,b,[class*="name"],[class*="title"]');
      const name = nameEl ? nameEl.innerText.trim() : text.split('\n')[0].trim();
      if (!name || name.length < 3 || seen.has(name)) return;
      seen.add(name);

      // Extract date
      const dateEl = card.querySelector('time,[class*="date"],[class*="Date"]');
      const date = dateEl ? (dateEl.getAttribute('datetime') || dateEl.innerText.trim()) : '';

      // Extract location
      const locEl = card.querySelector('[class*="location"],[class*="Location"],[class*="address"],[class*="city"]');
      const location = locEl ? locEl.innerText.trim() : '';

      // Extract URL
      const linkEl = card.querySelector('a[href]');
      const url = linkEl ? (linkEl.href.startsWith('http') ? linkEl.href : 'https://play.sorcerytcg.com' + linkEl.getAttribute('href')) : '';

      // Extract type/format
      const typeEl = card.querySelector('[class*="type"],[class*="format"],[class*="Format"]');
      const type = typeEl ? typeEl.innerText.trim() : '';

      results.push({ name, date, location, type, url });
    });

    // Fallback: grab all text blocks that look like events
    if (!results.length) {
      document.querySelectorAll('a[href*="/events/"]').forEach(a => {
        const name = a.innerText.trim();
        if (!name || seen.has(name)) return;
        seen.add(name);
        results.push({
          name,
          date: '',
          location: '',
          type: '',
          url: a.href
        });
      });
    }

    return results.slice(0, 100);
  });

  await browser.close();

  if (!events.length) {
    console.error('No events found — page may not have rendered correctly');
    // Write empty array so app knows scraper ran but found nothing
    fs.writeFileSync('events.json', JSON.stringify({ updated: new Date().toISOString(), events: [] }, null, 2));
    process.exit(0);
  }

  const output = {
    updated: new Date().toISOString(),
    events
  };

  fs.writeFileSync('events.json', JSON.stringify(output, null, 2));
  console.log(`Scraped ${events.length} events → events.json`);
})();
