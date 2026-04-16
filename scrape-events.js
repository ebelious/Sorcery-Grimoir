const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Intercept API calls made by the page to find the events data endpoint
  const apiCalls = [];
  page.on('response', async (response) => {
    const url = response.url();
    if ((url.includes('event') || url.includes('carde')) && 
        response.headers()['content-type']?.includes('json')) {
      try {
        const json = await response.json();
        apiCalls.push({ url, json });
        console.log('API response intercepted:', url.slice(0, 100));
      } catch(e) {}
    }
  });

  console.log('Fetching https://play.sorcerytcg.com/events...');
  await page.goto('https://play.sorcerytcg.com/events', {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  // Wait for events to load
  await page.waitForTimeout(5000);

  // Try clicking Show More to load all events
  try {
    const showMore = await page.$('button:has-text("Show More"), [class*="show-more"], [class*="ShowMore"], [class*="load-more"]');
    if (showMore) {
      console.log('Clicking Show More...');
      await showMore.click();
      await page.waitForTimeout(3000);
    }
  } catch(e) {}

  // Check if we intercepted API data
  let events = [];
  if (apiCalls.length) {
    console.log(`Intercepted ${apiCalls.length} API calls`);
    // Try to find events array in the responses
    for (const call of apiCalls) {
      const data = call.json;
      const arr = data?.data || data?.events || data?.results || data?.items || 
                  (Array.isArray(data) ? data : null);
      if (arr && arr.length) {
        console.log(`Found ${arr.length} events from API: ${call.url}`);
        events = arr.map(e => ({
          name: e.name || e.title || e.eventName || '',
          date: e.date || e.startDate || e.start_date || e.scheduledDate || '',
          time: e.time || e.startTime || e.start_time || '',
          location: e.location || e.venue || e.storeName || e.store_name || '',
          city: e.city || e.locationCity || '',
          state: e.state || e.locationState || e.region || '',
          address: e.address || e.fullAddress || e.location?.address || '',
          type: e.type || e.format || e.eventType || e.level || '',
          url: e.url || e.link || (e.id ? `https://play.sorcerytcg.com/events/${e.id}` : '')
        })).filter(e => e.name);
        break;
      }
    }
  }

  // Fallback: scrape from DOM
  if (!events.length) {
    console.log('No API data found, scraping DOM...');
    
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1000));
    console.log('Page preview:', bodyText);

    events = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Try every possible container
      const allEls = document.querySelectorAll('*');
      const containers = [];
      allEls.forEach(el => {
        const cn = (el.className || '').toString().toLowerCase();
        if (cn.includes('event') || cn.includes('card') || cn.includes('result')) {
          if (el.children.length > 0 && el.innerText?.length > 20) {
            containers.push(el);
          }
        }
      });

      // Deduplicate by text content
      const unique = containers.filter((el, i) => {
        return !containers.slice(0, i).some(prev => prev.contains(el));
      }).slice(0, 50);

      unique.forEach(card => {
        const text = (card.innerText || '').trim();
        const lines = text.split('\n').filter(l => l.trim());
        if (!lines.length || lines[0].length < 3) return;

        const name = lines[0].trim().slice(0, 120);
        if (!name || seen.has(name) || name.toLowerCase().includes('filter') || 
            name.toLowerCase().includes('search') || name.toLowerCase() === 'events') return;
        seen.add(name);

        const dateMatch = text.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2},?\s+\d{4})/i)
                       || text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
        const timeMatch = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))/);
        const stateMatch = text.match(/\b([A-Z]{2})\b.*\d{5}/);

        const linkEl = card.querySelector('a[href]');
        const url = linkEl?.href || '';

        results.push({
          name,
          date: dateMatch ? dateMatch[1] : '',
          time: timeMatch ? timeMatch[1] : '',
          location: lines[1]?.trim() || '',
          city: '',
          state: stateMatch ? stateMatch[1] : '',
          address: lines.slice(1,3).join(', '),
          type: '',
          url
        });
      });

      return results.slice(0, 100);
    });
  }

  await browser.close();

  const output = {
    updated: new Date().toISOString(),
    totalEvents: events.length,
    events
  };

  fs.writeFileSync('events.json', JSON.stringify(output, null, 2));
  console.log(`Done: ${events.length} events → events.json`);
})();
