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

  // Wait for content to render
  await page.waitForTimeout(4000);

  // Log page HTML snippet for debugging
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('Page text preview:', bodyText);

  const events = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Try multiple selectors for event containers
    const selectors = [
      '[class*="event-card"]', '[class*="EventCard"]',
      '[class*="event-item"]', '[class*="EventItem"]',
      '[class*="event-row"]',  '[class*="EventRow"]',
      'article', '[role="listitem"]',
      '[class*="card"]', '[class*="Card"]'
    ];

    let cards = [];
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 2) { cards = Array.from(found); break; }
    }

    // Fallback: any div with a link to /events/
    if (!cards.length) {
      document.querySelectorAll('a[href*="/events/"]').forEach(a => {
        const parent = a.closest('li,article,section,[class]') || a.parentElement;
        if (parent && !cards.includes(parent)) cards.push(parent);
      });
    }

    cards.forEach(card => {
      const text = (card.innerText || '').trim();
      if (!text || text.length < 5) return;

      // Name
      const nameEl = card.querySelector('h1,h2,h3,h4,[class*="title"],[class*="name"],[class*="Title"],[class*="Name"]');
      const name = (nameEl ? nameEl.innerText.trim() : text.split('\n')[0].trim()).slice(0, 120);
      if (!name || seen.has(name)) return;
      seen.add(name);

      // Date & Time - look for time elements or date-like text
      const timeEl = card.querySelector('time,[class*="date"],[class*="Date"],[class*="time"],[class*="Time"]');
      let date = '';
      let time = '';
      if (timeEl) {
        const raw = timeEl.getAttribute('datetime') || timeEl.innerText.trim();
        // Try to split date and time
        const timeParts = raw.match(/^(.+?)(?:\s+at\s+|\s+@\s+|,\s*)?(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm).*)?$/);
        if (timeParts) { date = timeParts[1]||raw; time = timeParts[2]||''; }
        else { date = raw; }
      }
      // Fallback: scan text for date patterns
      if (!date) {
        const dateMatch = text.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i)
                       || text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
        if (dateMatch) date = dateMatch[1];
      }
      // Time fallback
      if (!time) {
        const timeMatch = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))/);
        if (timeMatch) time = timeMatch[1];
      }

      // Location - store name, address, city, state
      const locEl = card.querySelector('[class*="location"],[class*="Location"],[class*="address"],[class*="Address"],[class*="venue"],[class*="Venue"],[class*="store"],[class*="Store"]');
      let location = locEl ? locEl.innerText.trim() : '';

      // Try to parse city and state from location or text
      let city = '', state = '', address = '';
      if (location) {
        // Pattern: "Store Name, City, ST 12345" or "City, ST"
        const cityStateMatch = location.match(/,\s*([A-Za-z\s]+),\s*([A-Z]{2})(?:\s+\d{5})?$/);
        if (cityStateMatch) {
          city = cityStateMatch[1].trim();
          state = cityStateMatch[2];
          address = location;
        } else {
          const stateMatch = location.match(/([A-Za-z\s]+),\s*([A-Z]{2})(?:\s+\d{5})?/);
          if (stateMatch) { city = stateMatch[1].trim(); state = stateMatch[2]; }
          address = location;
        }
      }

      // Format type
      const typeEl = card.querySelector('[class*="format"],[class*="Format"],[class*="type"],[class*="Type"],[class*="tag"],[class*="Tag"]');
      const type = typeEl ? typeEl.innerText.trim() : '';

      // URL
      const linkEl = card.querySelector('a[href]');
      const url = linkEl ? (linkEl.href.startsWith('http') ? linkEl.href : 'https://play.sorcerytcg.com' + linkEl.getAttribute('href')) : '';

      results.push({ name, date, time, location, city, state, address, type, url });
    });

    return results.slice(0, 100);
  });

  await browser.close();

  const output = {
    updated: new Date().toISOString(),
    events: events.length ? events : []
  };

  fs.writeFileSync('events.json', JSON.stringify(output, null, 2));
  console.log(`Scraped ${events.length} events → events.json`);
})();
