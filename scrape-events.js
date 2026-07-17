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
// TWO-PASS APPROACH: the summary cards on the /events listing page are
// unlikely to include a full description or exact street address -- that
// kind of detail normally only lives on each event's own detail page. So
// this scraper first collects event names + URLs from the listing page,
// then visits each event's individual page to pull the fuller info
// (store name, address, description) from there.
//
// NOTE: I couldn't inspect the live rendered pages' exact DOM/class names
// (no browser access in the environment this was written in), so the
// extraction below is a best-effort heuristic pass based on common patterns
// for this kind of event-listing SPA, not verified selectors. If results
// come back thin or wrong, check the workflow's logs -- diagnostic output
// (including one full sample event's raw text) is printed to help pinpoint
// exactly what needs fixing.

const { chromium } = require('playwright');
const fs = require('fs');

const EVENTS_URL = 'https://play.sorcerytcg.com/events?radius=250';
const MAX_DETAIL_VISITS = 75; // cap detail-page visits to keep runtime reasonable

const DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2}(st|nd|rd|th)?(,?\s+\d{4})?\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i;
const TIME_RE = /\b\d{1,2}:\d{2}\s*(am|pm)\b/i;
const CITY_STATE_RE = /^(.*?),\s*([A-Z]{2})\b/;
const ADDRESS_RE = /^\d{1,6}\s+\S+/; // starts with a street number
// The site explicitly labels event status with one of these words (found via
// live diagnostics -- a completed event's detail page literally contains the
// line "Complete"). Far more reliable than guessing from a parsed date.
const COMPLETED_STATUS_RE = /^(Complete|Completed|Cancelled|Canceled)$/i;

function extractFields(lines, fallbackName) {
  const dateLine = lines.find(l => DATE_RE.test(l)) || '';
  const timeLine = lines.find(l => TIME_RE.test(l)) || '';
  const cityStateLine = lines.find(l => CITY_STATE_RE.test(l)) || '';
  const cityMatch = cityStateLine.match(CITY_STATE_RE);
  const addressIdx = lines.findIndex(l => ADDRESS_RE.test(l) && l !== cityStateLine);
  const addressLine = addressIdx >= 0 ? lines[addressIdx] : '';

  // Store name and event type sit in fixed positions relative to the
  // address line on the detail page: address, then store name, then type
  // (e.g. "23 Princes Street...", "Card Merchant Dunedin", "Constructed
  // Tournament").
  const storeName = addressIdx >= 0 ? (lines[addressIdx + 1] || '') : '';
  const type = addressIdx >= 0 ? (lines[addressIdx + 2] || '') : '';

  // Description: the longest line that isn't one of the other identified
  // fields and isn't itself the event name -- descriptions are usually the
  // one clearly longer block of prose on the page. Many events won't have
  // one at all, which is fine -- this stays empty in that case.
  const excluded = new Set([dateLine, timeLine, cityStateLine, addressLine, storeName, type, fallbackName].filter(Boolean));
  const prose = lines
    .filter(l => !excluded.has(l) && l.length > 40)
    .sort((a, b) => b.length - a.length);
  const description = prose[0] || '';

  const statusLine = lines.find(l => COMPLETED_STATUS_RE.test(l)) || '';

  return {
    date: dateLine,
    time: timeLine,
    location: cityStateLine,
    city: cityMatch ? cityMatch[1].trim() : '',
    state: cityMatch ? cityMatch[2].trim() : '',
    address: addressLine,
    storeName,
    type,
    description,
    statusLine
  };
}

// Parses a loosely-formatted event date string (e.g. "Jul 20", "Jul 20,
// 2026", "07/20/2026") into a Date, for filtering out completed events.
// Returns null if it can't be parsed with any confidence.
function parseEventDate(dateStr) {
  if (!dateStr) return null;
  const cleaned = dateStr.replace(/^[A-Za-z]+,\s*/, '').replace(/(\d)(st|nd|rd|th)\b/i, '$1'); // strip leading weekday and ordinal suffix
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return d;
}

// True if this event should be shown (i.e. not completed/cancelled).
// Primary signal: the site's own explicit status line (e.g. "Complete"),
// which is far more reliable than parsing a date. Falls back to date
// comparison only when no status text was found. Events we truly can't
// determine anything about are kept (fail open).
function isUpcoming(statusLine, dateStr) {
  if (statusLine) return !COMPLETED_STATUS_RE.test(statusLine);
  const parsed = parseEventDate(dateStr);
  if (!parsed) return true;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return parsed.getTime() >= todayStart.getTime();
}

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Fetching ' + EVENTS_URL + '...');
  await page.goto(EVENTS_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.waitForSelector('a[href*="/events/"]', { timeout: 15000 }).catch(() => {});

  const { stubs, listDiagnostics } = await page.evaluate(() => {
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

      results.push({ name, url });
    });

    return {
      stubs: results.slice(0, 300),
      listDiagnostics: {
        totalEventLinks: links.length,
        bodyTextSample: document.body.innerText.slice(0, 500)
      }
    };
  });

  console.log('List page diagnostics:', JSON.stringify(listDiagnostics, null, 2));

  if (!stubs.length) {
    await browser.close();
    console.error('No events found on the listing page -- selectors need updating. See diagnostics above.');
    fs.writeFileSync('events.json', JSON.stringify({ updated: new Date().toISOString(), events: [] }, null, 2));
    process.exit(1);
  }

  console.log('Found ' + stubs.length + ' events on the listing page. Visiting up to ' + MAX_DETAIL_VISITS + ' detail pages...');

  const events = [];
  let sampleLogged = false;
  let skippedCompleted = 0;

  for (let i = 0; i < Math.min(stubs.length, MAX_DETAIL_VISITS); i++) {
    const stub = stubs[i];
    try {
      await page.goto(stub.url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1000);

      const lines = await page.evaluate(() =>
        document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean)
      );

      const fields = extractFields(lines, stub.name);

      if (!isUpcoming(fields.statusLine, fields.date)) {
        skippedCompleted++;
        if (!sampleLogged) {
          console.log('Sample event detail lines (first event, for debugging):', JSON.stringify(lines.slice(0, 30), null, 2));
          sampleLogged = true;
        }
        continue; // completed/cancelled event -- don't include it
      }

      events.push({
        name: stub.name,
        date: fields.date,
        time: fields.time,
        type: fields.type,
        location: fields.location,
        city: fields.city,
        state: fields.state,
        address: fields.address,
        description: fields.description,
        storeName: fields.storeName,
        url: stub.url
      });

      if (!sampleLogged) {
        console.log('Sample event detail lines (first event, for debugging):', JSON.stringify(lines.slice(0, 30), null, 2));
        sampleLogged = true;
      }
    } catch (e) {
      console.log('  [' + stub.name + '] detail page failed -- ' + e.message + '; keeping list-page name only');
      events.push({
        name: stub.name, date: '', time: '', type: '', location: '',
        city: '', state: '', address: '', description: '', storeName: '', url: stub.url
      });
    }
  }

  // Any remaining events beyond MAX_DETAIL_VISITS keep just their name/url
  // from the listing page rather than being dropped entirely (no date was
  // fetched for these, so they can't be filtered as completed -- kept as-is).
  for (let i = MAX_DETAIL_VISITS; i < stubs.length; i++) {
    const stub = stubs[i];
    events.push({
      name: stub.name, date: '', time: '', type: '', location: '',
      city: '', state: '', address: '', description: '', storeName: '', url: stub.url
    });
  }

  console.log('Filtered out ' + skippedCompleted + ' completed event(s). Keeping ' + events.length + '.');

  await browser.close();

  const output = {
    updated: new Date().toISOString(),
    source: EVENTS_URL,
    events
  };

  fs.writeFileSync('events.json', JSON.stringify(output, null, 2));
  console.log('Done -- scraped ' + events.length + ' upcoming events (' + skippedCompleted + ' completed events filtered out; detail pages visited: ' + Math.min(stubs.length, MAX_DETAIL_VISITS) + ') to events.json');
})();
