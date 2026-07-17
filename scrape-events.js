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
// APPROACH (v3): live diagnostics showed the /events LISTING page itself
// already has a clean, consistently-ordered repeating text pattern per
// event card:
//   Event Name
//   Complete                       <- a publish/listing status, NOT whether
//                                      the event has occurred (confirmed: it
//                                      appears on every event including ones
//                                      running months into the future -- so
//                                      it is NOT used for filtering)
//   City, Region
//   Mon D, YYYY - Mon D, YYYY      <- date RANGE for the whole recurring series
//   H:MM AM/PM UTC
//   N Players                      <- optional
//   Store Name
//   Event Type
//   FREE / $price
//
// This is far more reliable than guessing from a single per-event detail
// page, and also gives us the full date RANGE (a recurring series is
// "upcoming" as long as its range hasn't fully ended, even if the range's
// start date is in the past). Extraction anchors on the date-range line
// (a very distinctive pattern) and reads fixed offsets around it.
//
// The one thing the listing page does NOT have is the exact street address
// -- that still requires visiting each event's own detail page, so this
// keeps a second pass for that specifically (capped, and much lighter than
// before since it's only pulling one field now).
//
// NOTE: this is still a best-effort heuristic pass, not verified selectors
// -- I don't have live browser access to inspect the actual DOM. If results
// come back thin or wrong, check the workflow's logs -- diagnostic output
// is printed to help pinpoint exactly what needs fixing.

const { chromium } = require('playwright');
const fs = require('fs');

const EVENTS_URL = 'https://play.sorcerytcg.com/events?radius=250';
const MAX_DETAIL_VISITS = 75; // cap detail-page visits (address lookup only) to keep runtime reasonable

const MONTH = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const DATE_RANGE_RE = new RegExp('^(' + MONTH + ')\\w*\\.?\\s+\\d{1,2},\\s+\\d{4}\\s*-\\s*(' + MONTH + ')\\w*\\.?\\s+\\d{1,2},\\s+\\d{4}$', 'i');
const TIME_RE = /^\d{1,2}:\d{2}\s*(AM|PM)\b/i;
const PLAYERS_RE = /^\d+\s+Players?$/i;
const CITY_REGION_RE = /^[^,]+,\s*[^,]+$/; // "City, Region" -- loose, region isn't always a 2-letter US state
const ADDRESS_RE = /^\d{1,6}\s+\S+/; // starts with a street number

function parseRangeDate(str) {
  const d = new Date(str.trim());
  return isNaN(d.getTime()) ? null : d;
}

// Extracts one event's fields from the lines immediately surrounding a
// date-range match at index `i`.
function extractFromListing(lines, i) {
  const dateRangeLine = lines[i];
  const [startStr, endStr] = dateRangeLine.split(/\s*-\s*/);
  const startDate = parseRangeDate(startStr);
  const endDate = parseRangeDate(endStr);

  const name = lines[i - 2] || '';
  const location = CITY_REGION_RE.test(lines[i - 1] || '') ? lines[i - 1] : '';
  const cityMatch = location.match(/^([^,]+),\s*(.+)$/);

  let j = i + 1;
  const time = TIME_RE.test(lines[j] || '') ? lines[j] : '';
  if (time) j++;
  if (PLAYERS_RE.test(lines[j] || '')) j++; // skip optional player count
  const storeName = lines[j] || '';
  const type = lines[j + 1] || '';
  // (lines[j+2] would be the price -- not needed for our schema)

  return {
    name,
    location,
    city: cityMatch ? cityMatch[1].trim() : '',
    state: cityMatch ? cityMatch[2].trim() : '',
    dateRange: dateRangeLine,
    startDate,
    endDate,
    time,
    storeName,
    type
  };
}

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Fetching ' + EVENTS_URL + '...');
  await page.goto(EVENTS_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.waitForSelector('a[href*="/events/"]', { timeout: 15000 }).catch(() => {});

  const { parsed, urlsByName, listDiagnostics } = await page.evaluate((datePattern) => {
    const dateRangeRe = new RegExp(datePattern, 'i');
    const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);

    // Map event name -> URL from the anchor tags (used to attach links to
    // the text-parsed events below).
    const urlsByName = {};
    const seenUrls = new Set();
    Array.from(document.querySelectorAll('a[href*="/events/"]')).forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!href || href === '/events' || href.startsWith('/events?')) return;
      const url = href.startsWith('http') ? href : 'https://play.sorcerytcg.com' + href;
      if (seenUrls.has(url)) return;
      seenUrls.add(url);
      const card = a.closest('[class]') || a;
      const heading = card.querySelector('h1,h2,h3,h4,h5,strong');
      const name = (heading ? heading.innerText : a.innerText || '').trim().split('\n')[0];
      if (name && !urlsByName[name]) urlsByName[name] = url;
    });

    const dateRangeIndexes = [];
    lines.forEach((l, idx) => { if (dateRangeRe.test(l)) dateRangeIndexes.push(idx); });

    return {
      parsed: { lines, dateRangeIndexes },
      urlsByName,
      listDiagnostics: {
        totalEventLinks: seenUrls.size,
        dateRangeLinesFound: dateRangeIndexes.length,
        bodyTextSample: document.body.innerText.slice(0, 800)
      }
    };
  }, DATE_RANGE_RE.source);

  console.log('List page diagnostics:', JSON.stringify(listDiagnostics, null, 2));

  if (!listDiagnostics.dateRangeLinesFound) {
    await browser.close();
    console.error('No date-range patterns found on the listing page -- page structure may have changed. See diagnostics above.');
    fs.writeFileSync('events.json', JSON.stringify({ updated: new Date().toISOString(), events: [] }, null, 2));
    process.exit(1);
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const stubs = parsed.dateRangeIndexes
    .map(i => extractFromListing(parsed.lines, i))
    .filter(e => e.name)
    .map(e => ({ ...e, url: urlsByName[e.name] || '' }));

  console.log('Parsed ' + stubs.length + ' events from the listing page.');

  // Filter using the date RANGE's end date -- a recurring series is still
  // upcoming as long as it hasn't fully ended, even if its start date (and
  // the "Complete" listing-status label) are in the past. Events whose end
  // date we couldn't parse are kept (fail open).
  const upcoming = stubs.filter(e => !e.endDate || e.endDate.getTime() >= todayStart.getTime());
  const skippedEnded = stubs.length - upcoming.length;
  console.log('Filtered out ' + skippedEnded + ' event(s) whose date range has fully ended. Keeping ' + upcoming.length + '.');

  console.log('Visiting up to ' + MAX_DETAIL_VISITS + ' detail pages for street addresses...');

  const events = [];
  let sampleLogged = false;

  for (let i = 0; i < upcoming.length; i++) {
    const e = upcoming[i];
    let address = '';

    if (e.url && i < MAX_DETAIL_VISITS) {
      try {
        await page.goto(e.url, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(1000);
        const detailLines = await page.evaluate(() =>
          document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean)
        );
        const addrLine = detailLines.find(l => ADDRESS_RE.test(l));
        if (addrLine) address = addrLine;

        if (!sampleLogged) {
          console.log('Sample detail page lines (first event, for debugging):', JSON.stringify(detailLines.slice(0, 20), null, 2));
          sampleLogged = true;
        }
      } catch (err) {
        console.log('  [' + e.name + '] detail page failed -- ' + err.message);
      }
    }

    events.push({
      name: e.name,
      date: e.dateRange,
      time: e.time,
      type: e.type,
      location: e.location,
      city: e.city,
      state: e.state,
      address,
      description: '',
      storeName: e.storeName,
      url: e.url
    });
  }

  await browser.close();

  const output = {
    updated: new Date().toISOString(),
    source: EVENTS_URL,
    events
  };

  fs.writeFileSync('events.json', JSON.stringify(output, null, 2));
  console.log('Done -- scraped ' + events.length + ' upcoming events to events.json');
})();
