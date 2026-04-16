const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Intercept API calls - carde.io may return structured JSON
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

  // Click Show More to get all events
  let clickCount = 0;
  while (clickCount < 10) {
    try {
      const btn = await page.$('button:has-text("Show More"), button:has-text("Load More"), button:has-text("See More")');
      if (!btn) break;
      const visible = await btn.isVisible();
      if (!visible) break;
      await btn.click();
      await page.waitForTimeout(2000);
      clickCount++;
      console.log('Clicked Show More:', clickCount);
    } catch(e) { break; }
  }

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1000));
  console.log('Page preview:', bodyText);

  // Log full HTML for debugging on first run
  const fullHTML = await page.evaluate(() => document.body.innerHTML.slice(0, 3000));
  console.log('HTML preview:', fullHTML);

  let events = [];

  // Try API data first
  if (apiCalls.length) {
    console.log('API calls intercepted:', apiCalls.length);
    for (const call of apiCalls) {
      const d = call.json;
      const arr = d?.data || d?.events || d?.results || d?.items || (Array.isArray(d) ? d : null);
      if (arr && arr.length) {
        console.log('Events from API:', arr.length, call.url.slice(0, 80));
        console.log('Sample event keys:', Object.keys(arr[0]).join(', '));
        console.log('Sample event:', JSON.stringify(arr[0]).slice(0, 300));
        events = arr.map(e => ({
          name: e.name || e.title || e.eventName || e.event_name || '',
          date: e.date || e.startDate || e.start_date || e.scheduledDate || e.scheduled_date || e.eventDate || '',
          time: e.time || e.startTime || e.start_time || e.eventTime || '',
          location: e.location || e.venue || e.storeName || e.store_name || e.venueName || e.venue_name || '',
          city: e.city || e.locationCity || e.location_city || e.venue?.city || '',
          state: e.state || e.locationState || e.location_state || e.region || e.venue?.state || '',
          address: e.address || e.fullAddress || e.full_address || e.street || e.venue?.address || '',
          zip: e.zip || e.zipCode || e.zip_code || e.postalCode || '',
          country: e.country || e.countryCode || '',
          type: e.type || e.format || e.eventType || e.event_type || e.level || e.formatName || '',
          description: e.description || e.details || e.notes || '',
          organizer: e.organizer || e.organizerName || e.store || e.storeName || '',
          entryFee: e.entryFee || e.entry_fee || e.fee || e.cost || e.price || '',
          players: e.players || e.playerCount || e.maxPlayers || e.capacity || '',
          url: e.url || e.link || e.eventUrl || (e.id ? 'https://play.sorcerytcg.com/events/' + e.id : '') || (e.slug ? 'https://play.sorcerytcg.com/events/' + e.slug : '')
        })).filter(e => e.name);
        break;
      }
    }
  }

  // DOM fallback
  if (!events.length) {
    console.log('No API data, scraping DOM...');
    events = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      const selectors = [
        '[class*="event-card"]', '[class*="EventCard"]',
        '[class*="event-item"]', '[class*="EventItem"]',
        '[class*="event-row"]', '[class*="EventRow"]',
        'article', '[role="listitem"]',
        '[class*="card"]', '[class*="Card"]'
      ];

      let cards = [];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 2) { cards = Array.from(found); break; }
      }

      if (!cards.length) {
        document.querySelectorAll('a[href*="/events/"]').forEach(a => {
          const p = a.closest('li,article,section,[class]') || a.parentElement;
          if (p && !cards.includes(p)) cards.push(p);
        });
      }

      cards.forEach(card => {
        const text = (card.innerText || '').trim();
        if (!text || text.length < 5) return;

        const nameEl = card.querySelector('h1,h2,h3,h4,[class*="title"],[class*="name"],[class*="Title"],[class*="Name"]');
        const name = (nameEl ? nameEl.innerText.trim() : text.split('\n')[0].trim()).slice(0, 120);
        if (!name || seen.has(name)) return;
        seen.add(name);

        // Date & time
        const timeEl = card.querySelector('time,[class*="date"],[class*="Date"],[class*="time"],[class*="Time"]');
        let date = '', time = '';
        if (timeEl) {
          const raw = timeEl.getAttribute('datetime') || timeEl.innerText.trim();
          const timeParts = raw.match(/^(.+?)(?:\s+at\s+|\s+@\s+|,\s*)?(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm).*)?$/);
          if (timeParts) { date = timeParts[1]||raw; time = timeParts[2]||''; }
          else { date = raw; }
        }
        if (!date) {
          const dm = text.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2},?\s+\d{4})/i)
                  || text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
          if (dm) date = dm[1];
        }
        if (!time) {
          const tm = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))/);
          if (tm) time = tm[1];
        }

        // Location
        const locEl = card.querySelector('[class*="location"],[class*="Location"],[class*="address"],[class*="Address"],[class*="venue"],[class*="Venue"],[class*="store"],[class*="Store"]');
        let location = locEl ? locEl.innerText.trim() : '';
        let city = '', state = '', address = '';
        if (location) {
          const csm = location.match(/,\s*([A-Za-z\s]+),\s*([A-Z]{2})(?:\s+\d{5})?$/);
          if (csm) { city = csm[1].trim(); state = csm[2]; address = location; }
          else {
            const sm = location.match(/([A-Za-z\s]+),\s*([A-Z]{2})(?:\s+\d{5})?/);
            if (sm) { city = sm[1].trim(); state = sm[2]; }
            address = location;
          }
        }

        // Type/format
        const typeEl = card.querySelector('[class*="format"],[class*="Format"],[class*="type"],[class*="Type"],[class*="tag"],[class*="Tag"],[class*="level"],[class*="Level"]');
        const type = typeEl ? typeEl.innerText.trim() : '';

        // Description
        const descEl = card.querySelector('[class*="desc"],[class*="Desc"],[class*="detail"],[class*="Detail"],[class*="note"],[class*="Note"],p');
        const description = descEl ? descEl.innerText.trim().slice(0, 300) : '';

        // Entry fee
        const feeMatch = text.match(/\$[\d.]+/);
        const entryFee = feeMatch ? feeMatch[0] : '';

        // Players/capacity
        const playersMatch = text.match(/(\d+)\s*(?:players?|seats?|spots?|max)/i);
        const players = playersMatch ? playersMatch[1] : '';

        const linkEl = card.querySelector('a[href]');
        const url = linkEl ? (linkEl.href.startsWith('http') ? linkEl.href : 'https://play.sorcerytcg.com' + linkEl.getAttribute('href')) : '';

        results.push({ name, date, time, location, city, state, address, type, description, entryFee, players, url });
      });

      return results.slice(0, 100);
    });
  }

  await browser.close();

  const output = {
    updated: new Date().toISOString(),
    total: events.length,
    events
  };

  fs.writeFileSync('events.json', JSON.stringify(output, null, 2));
  console.log('Done:', events.length, 'events written to events.json');
})();
