const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const apiCalls = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('api.carde.io/api/play/events') &&
        (response.headers()['content-type'] || '').includes('json')) {
      try {
        const json = await response.json();
        apiCalls.push({ url, json });
      } catch(e) {}
    }
  });

  await page.goto('https://play.sorcerytcg.com/events', {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  await page.waitForTimeout(5000);

  // Click Show More to load all events (up to 500)
  let clickCount = 0;
  while (clickCount < 25) {
    try {
      const btn = await page.$('button:has-text("Show More"), button:has-text("Load More")');
      if (!btn) break;
      if (!(await btn.isVisible())) break;
      await btn.click();
      await page.waitForTimeout(1500);
      clickCount++;
    } catch(e) { break; }
  }
  console.log('Show More clicks:', clickCount);

  await browser.close();

  // Merge all intercepted API responses
  let allEvents = [];
  const seen = new Set();
  for (const call of apiCalls) {
    const d = call.json;
    const arr = d?.data || d?.events || d?.results || d?.items || (Array.isArray(d) ? d : null);
    if (!arr) continue;
    arr.forEach(e => {
      if (!e.id || seen.has(e.id)) return;
      seen.add(e.id);

      // Parse address fields
      const addr = e.address || {};
      const city    = addr.city    || addr.locality || '';
      const state   = addr.state   || addr.region   || addr.province || '';
      const country = addr.country || addr.countryCode || '';
      const street  = addr.street  || addr.line1    || addr.streetAddress || '';
      const zip     = addr.zip     || addr.postalCode || addr.postal_code || '';
      const fullAddr = [street, city, state, zip, country].filter(Boolean).join(', ');
      const location = e.owner || addr.name || city || '';

      // Parse dates
      const startDate = e.startsAt ? new Date(e.startsAt) : null;
      const endDate   = e.endsAt   ? new Date(e.endsAt)   : null;
      const date = startDate ? startDate.toLocaleDateString('en-US', {weekday:'short', year:'numeric', month:'short', day:'numeric'}) : '';
      const time = startDate ? startDate.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit', timeZoneName:'short'}) : '';
      const endDateStr = endDate ? endDate.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '';

      // Entry fee from ticketPrices
      let entryFee = 'FREE';
      if (e.ticketPrices && e.ticketPrices.length) {
        const price = e.ticketPrices[0];
        entryFee = price.amount > 0 ? '$' + (price.amount / 100).toFixed(2) : 'FREE';
      }

      // Format from activities or configuration
      let type = '';
      if (e.activities && e.activities.length) {
        type = e.activities.map(a => a.name || a.format || a.type || '').filter(Boolean).join(', ');
      }
      if (!type && e.configuration) {
        type = e.configuration.format || e.configuration.type || '';
      }

      allEvents.push({
        id: e.id,
        name: e.name || '',
        status: e.status || '',
        date,
        time,
        endDate: endDateStr,
        location,
        city,
        state,
        country,
        address: fullAddr,
        street,
        zip,
        type,
        entryFee,
        capacity: e.capacity || '',
        registered: e.registrationCount || 0,
        organizer: e.owner || '',
        bannerImage: e.bannerImage || '',
        url: 'https://play.sorcerytcg.com/events/' + e.id
      });
    });
  }

  console.log('Total unique events:', allEvents.length);

  // Sort by start date
  allEvents.sort((a, b) => new Date(a.date) - new Date(b.date));

  fs.writeFileSync('events.json', JSON.stringify({
    updated: new Date().toISOString(),
    total: allEvents.length,
    events: allEvents
  }, null, 2));

  console.log('Done:', allEvents.length, 'events written to events.json');
})();
