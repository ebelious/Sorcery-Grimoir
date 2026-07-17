// Scrapes upcoming Sorcery TCG events from the official Play Network
// (https://play.sorcerytcg.com/events), powered by Carde.io.
//
// The app already has a fully-built Events viewer (city search, geolocation,
// saved events, detail popups) that fetches this file's output from
// https://ebelious.github.io/Sorcery-Grimoir/events.json -- see
// loadLocalEvents() in index.html. This scraper's job is just to keep that
// file populated with events shaped to match what that UI reads:
//   { name, date, time, type, location, city, state, address, description, url }
//
// This page renders its event list client-side via JS (no public API is
// documented for it), so this uses Playwright the same way scrape-news.js
// does: load the page in a headless browser, wait for it to hydrate, then
// read the rendered DOM.
//
// NOTE: I couldn't inspect the live rendered page's exact DOM/class names
// (no browser access in the environment this was written in), so the
// selectors below are a best-effort guess based on common patterns for
// this kind of event-listing SPA. If this comes back with 0 events, check
// the workflow's logs -- diagnostic output below shows what was actually
// found on the page, which is the fastest way to tell me what to fix.

const { chromium } = require('playwright');
const fs = require('fs');

const EVENTS_URL = 'https://play.sorcerytcg.com/events?radius=250';

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Fetching ' + EVENTS_URL + '...');
  await page.goto(EVENTS_URL, {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  // Give the SPA extra time to finish hydrating/rendering event cards after
  // its network requests settle.
  await page.waitForTimeout(3000);
  await page.waitForSelector('a[href*="/events/"]', { timeout: 15000 }).catch(() => {});

  const { events, diagnostics } = await page.evaluate(() => {
    const seen = new Set();
    const results = [];
    const links = Array.from(document.querySelectorAll('a[href*="/events/"]'));

    links.forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!href || href === '/events' || href.startsWith('/events?')) return;

      const url = href.startsWith('http') ? href : 'https://play.sorcerytcg.com' + href;
      if (seen.has(url)) return;
      seen.add(url);

      const card = a.closest('[class]') || a;
      const heading = card.querySelector('h1,h2,h3,h4,h5,strong');
      const name = (heading ? heading.innerText : a.innerText || '').trim().split('\n')[0];
      if (!name) return;

      const fullText = card.innerText ? card.innerText.trim() : '';
      const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);

      // Rough field guesses from the card's raw text.
      const dateLine = lines.find(l => /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}/i.test(l) || /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(l)) || '';
      const timeLine = lines.find(l => /\d{1,2}:\d{2}\s*(am|pm)/i.test(l)) || '';
      const cityStateLine = lines.find(l => /,\s*[A-Z]{2}\b/.test(l)) || '';
      const cityMatch = cityStateLine.match(/^(.*?),\s*([A-Z]{2})\b/);

      results.push({
        name,
        date: dateLine,
        time: timeLine,
        type: '',
        location: cityStateLine,
        city: cityMatch ? cityMatch[1].trim() : '',
        state: cityMatch ? cityMatch[2].trim() : '',
        address: '',
        description: '',
        url
      });
    });

    return {
      events: results.slice(0, 200),
      diagnostics: {
        totalEventLinks: links.length,
        bodyTextSample: document.body.innerText.slice(0, 500)
      }
    };
  });

  console.log('Diagnostics:', JSON.stringify(diagnostics, null, 2));

  await browser.close();

  if (!events.length) {
    console.error('No events found -- page may not have rendered correctly, or selectors need updating. See diagnostics above.');
    fs.writeFileSync('events.json', JSON.stringify({ updated: new Date().toISOString(), events: [] }, null, 2));
    process.exit(1);
  }

  const output = {
    updated: new Date().toISOString(),
    source: EVENTS_URL,
    events
  };

  fs.writeFileSync('events.json', JSON.stringify(output, null, 2));
  console.log('Done -- scraped ' + events.length + ' events to events.json');
})();
