const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const apiCalls = [];
  page.on('response', async (response) => {
    const url = response.url();
    if ((url.includes('event') || url.includes('carde')) &&
        (response.headers()['content-type'] || '').includes('json')) {
      try {
        const json = await response.json();
        apiCalls.push({ url, json });
        console.log('API intercepted:', url.slice(0, 100));
      } catch(e) {}
    }
  });

  console.log('Fetching https://play.sorcerytcg.com/events...');
  await page.goto('https://play.sorcerytcg.com/events', {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  await page.waitForTimeout(5000);

  try {
    const btn = await page.$('button:has-text("Show More")');
    if (btn) { await btn.click(); await page.waitForTimeout(3000); }
  } catch(e) {}

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('Page preview:', bodyText);

  let events = [];

  if (apiCalls.length) {
    console.log('API calls intercepted:', apiCalls.length);
    for (const call of apiCalls) {
      const d = call.json;
      const arr = d?.data || d?.events || d?.results || d?.items || (Array.isArray(d) ? d : null);
      if (arr && arr.length) {
        console.log('Events from API:', arr.length, call.url.slice(0, 80));
        events = arr.map(e => ({
          name: e.name || e.title || e.eventName || '',
          date: e.date || e.startDate || e.start_date || e.scheduledDate || '',
          time: e.time || e.startTime || e.start_time || '',
          location: e.location || e.venue || e.storeName || e.store_name || '',
          city: e.city || e.locationCity || '',
          state: e.state || e.locationState || e.region || '',
          address: e.address || e.fullAddress || '',
          type: e.type || e.format || e.eventType || e.level || '',
          url: e.url || e.link || (e.id ? 'https://play.sorcerytcg.com/events/' + e.id : '')
        })).filter(e => e.name);
        break;
      }
    }
  }

  if (!events.length) {
    console.log('No API data, falling back to DOM scrape...');
    events = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const selectors = ['[class*="event-card"]','[class*="EventCard"]','[class*="event-item"]','article','[role="listitem"]'];
      let cards = [];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 2) { cards = Array.from(found); break; }
      }
      if (!cards.length) {
        document.querySelectorAll('a[href*="/events/"]').forEach(a => {
          const p = a.closest('li,article,div') || a.parentElement;
          if (p && !cards.includes(p)) cards.push(p);
        });
      }
      cards.forEach(card => {
        const text = (card.innerText || '').trim();
        if (!text || text.length < 5) return;
        const name = text.split('\n')[0].trim().slice(0, 120);
        if (!name || seen.has(name)) return;
        seen.add(name);
        const dateMatch = text.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2},?\s+\d{4})/i) || text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
        const timeMatch = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))/);
        const stateMatch = text.match(/,\s*([A-Z]{2})\b/);
        const linkEl = card.querySelector('a[href]');
        results.push({
          name,
          date: dateMatch ? dateMatch[1] : '',
          time: timeMatch ? timeMatch[1] : '',
          location: text.split('\n')[1]?.trim() || '',
          city: '',
          state: stateMatch ? stateMatch[1] : '',
          address: '',
          type: '',
          url: linkEl?.href || ''
        });
      });
      return results.slice(0, 100);
    });
  }

  await browser.close();
  fs.writeFileSync('events.json', JSON.stringify({ updated: new Date().toISOString(), events }, null, 2));
  console.log('Done:', events.length, 'events written to events.json');
})();
