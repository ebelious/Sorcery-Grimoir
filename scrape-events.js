// Scrapes upcoming Sorcery TCG events from the official Play Network
// (https://play.sorcerytcg.com/events), which is powered by Carde.io.
//
// This page renders its event list client-side via JS (no public API is
// documented for it), so this uses Playwright the same way scrape-news.js
// does: load the page in a headless browser, wait for it to hydrate, then
// read the rendered DOM.
//
// NOTE: I couldn't inspect the live rendered page's exact DOM/class names
// (no browser access in the environment this was written in), so the
// selectors below are a best-effort guess based on common patterns for
// this kind of event-listing SPA (event cards linking to a detail page
// under /events/<id>). If this comes back with 0 events, check the
// workflow's logs -- diagnostic output below will show what was actually
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
  // its network requests settle -- some client-rendered lists paint a beat
  // after networkidle fires.
  await page.waitForTimeout(3000);

  // Try waiting for something that looks like an event card or list item.
  // Adjust this selector once the real markup is known.
  await page.waitForSelector('a[href*="/events/"]', { timeout: 15000 }).catch(() => {});

  const { events, diagnostics } = await page.evaluate(() => {
    const seen = new Set();
    const results = [];

    // Primary strategy: event cards are usually links to a detail page.
    const links = Array.from(document.querySelectorAll('a[href*="/events/"]'));

    links.forEach(a => {
      const href = a.getAttribute('href') || '';
      // Skip the top-nav "Events" link itself and any non-detail links.
      if (!href || href === '/events' || href.startsWith('/events?')) return;

      const url = href.startsWith('http') ? href : 'https://play.sorcerytcg.com' + href;
      if (seen.has(url)) return;
      seen.add(url);

      // Pull whatever text is inside the card -- title is usually the
      // largest/first heading-like element; date and location are
      // typically nearby text nodes or siblings.
      const card = a.closest('[class]') || a;
      const heading = card.querySelector('h1,h2,h3,h4,h5,strong');
      const title = (heading ? heading.innerText : a.innerText || '').trim().split('\n')[0];

      const fullText = card.innerText ? card.innerText.trim() : '';
      // Very rough date/location guesses from the card's raw text -- a
      // date-like line (contains a month name or digits with slashes/dashes)
      // and whatever line looks like "City, ST" or similar.
      const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
      const dateLine = lines.find(l => /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}/i.test(l) || /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(l)) || '';
      const locationLine = lines.find(l => /,\s*[A-Z]{2}\b/.test(l)) || '';

      if (!title) return;

      results.push({
        title,
        url,
        date: dateLine,
        location: locationLine,
        rawText: fullText.slice(0, 300) // kept temporarily for debugging; safe to remove once fields are verified accurate
      });
    });

    return {
      events: results.slice(0, 100),
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
