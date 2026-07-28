// Scrapes upcoming Sorcery TCG events from the official Play Network
// (https://play.sorcerytcg.com/events), powered by Carde.io.
//
// The app already has a fully-built Events viewer (city search, geolocation,
// saved events, detail popups) that fetches this file's output from
// https://ebelious.github.io/Sorcery-Grimoir/events.json -- see
// loadLocalEvents() in index.html. This scraper's job is just to keep that
// file populated with events shaped to match what that UI reads:
//   { name, date, time, type, price, duration, location, city, state, lat, lng, address, description, url }
//
// lat/lng are geocoded from city+state via Nominatim (OpenStreetMap, free,
// no API key) and cached across runs in events-geocode-cache.json so the
// same city isn't re-geocoded every scrape -- this is what lets the app do
// real straight-line-distance ("N miles from me") filtering client-side
// instead of the plain substring city/state text matching it fell back to
// before this existed.
//
// APPROACH (v4): live diagnostics revealed each event card on the /events
// LISTING page follows this exact 9-line repeating pattern:
//   Event Name
//   Complete | Upcoming            <- explicit status (BOTH values seen live)
//   City, Region
//   <date>                          <- EITHER a single date ("Thu. Jul 16, 2026")
//                                      OR a range ("Apr 30, 2026 - Dec 31, 2026")
//                                      for recurring series -- both formats occur
//   H:MM AM/PM UTC
//   N Players
//   Store Name
//   Event Type
//   FREE / $price
//
// Two bugs fixed in this version vs the prior one:
//   1. Only the date-RANGE format was being matched, so single-date events
//      (the majority, it turns out) were silently skipped entirely.
//   2. The name/status/location offsets relative to the date line were
//      miscounted by one position, so "name" was actually capturing the
//      status word instead of the real event name.
//
// Filtering: for single-date events, the explicit status ("Upcoming" vs
// "Complete") is trusted directly -- live data confirmed both values are
// genuinely used to mean whether that occurrence has happened yet. For
// date-range (recurring series) events, status is NOT trusted for this
// (both range events sampled showed "Complete" despite running months into
// the future -- for a series, that label appears to describe the reference
// occurrence, not the series as a whole) -- the range's END date is used
// instead, keeping the series as long as it hasn't fully concluded.
//
// The listing page does NOT have the exact street address -- that still
// requires visiting each event's own detail page.
//
// NOTE: still a best-effort heuristic pass, not verified selectors -- no
// live browser access to inspect the actual DOM directly. If results come
// back thin or wrong, the workflow's logs include diagnostic output to help
// pinpoint exactly what needs fixing.

const { chromium } = require('playwright');
const fs = require('fs');

const EVENTS_URL = 'https://play.sorcerytcg.com/events?locationType=in-person&radius=25';
const MAX_DETAIL_VISITS = 250; // cap detail-page visits (address/price/duration lookup) to keep runtime reasonable
const SEEN_STATE_FILE = 'events-seen-state.json'; // tracks event URLs seen in prior runs, so we only notify about genuinely new events

// Mirrors the app's own favorite-store topic naming (see index.html) --
// FCM topic names only allow [a-zA-Z0-9-_.~%], so store names get
// lowercased, non-matching characters collapsed to a single "-", and
// prefixed so they can't collide with the fixed global topics (news/
// discord/youtube/rewards).
function storeTopicName(storeName) {
  const slug = (storeName || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? 'store-' + slug : null;
}
const GEOCODE_STATE_FILE = 'events-geocode-cache.json'; // persists city/state -> lat/lng across runs so we don't re-geocode the same places every 90 seconds

// Nominatim (OpenStreetMap's free geocoder, no API key) enforces a hard
// 1-request/second limit and requires an identifying User-Agent -- both
// matter here since dozens of events can share a handful of cities, so we
// geocode each unique city/state pair only once per run (and persist the
// result across runs in GEOCODE_STATE_FILE, so a city already looked up
// last week never needs a fresh request at all).
const NOMINATIM_USER_AGENT = 'Sorcery-Grimoir-EventScraper/1.0 (https://github.com/ebelious/Sorcery-Grimoir)';
async function _nominatimSearch(q) {
  const res = await fetch(
    'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) + '&format=json&limit=1',
    { headers: { 'User-Agent': NOMINATIM_USER_AGENT } }
  );
  const results = res.ok ? await res.json() : [];
  return results && results[0];
}
async function geocode(city, state, cache) {
  const key = (city + '|' + state).toLowerCase().trim();
  if (cache[key] !== undefined) return cache[key]; // includes cached nulls (a previous failed lookup), so we don't retry those every run either
  const q = [city, state].filter(Boolean).join(', ');
  if (!q) { cache[key] = null; return null; }
  try {
    let hit = await _nominatimSearch(q);
    // If the exact "city, state" combination doesn't resolve, retry with
    // progressively simpler queries -- e.g. "Blenheim Central, Marlborough
    // Region" failed live, almost certainly because "Central" is some kind
    // of store/area qualifier rather than genuinely part of the place
    // name, while "Blenheim, Marlborough Region" or just "Blenheim" alone
    // would very likely succeed. Each retry costs one more rate-limited
    // request, so this only kicks in on an actual failure, not every call.
    if (!hit && city && state) {
      await new Promise(r => setTimeout(r, 1100));
      hit = await _nominatimSearch(city);
    }
    if (!hit && city && city.trim().indexOf(' ') >= 0) {
      await new Promise(r => setTimeout(r, 1100));
      hit = await _nominatimSearch(city.trim().split(/\s+/)[0]);
    }
    cache[key] = hit ? { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) } : null;
  } catch (e) {
    cache[key] = null;
  }
  await new Promise(r => setTimeout(r, 1100)); // stay under Nominatim's 1 req/sec limit
  return cache[key];
}

const MONTH = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const DATE_RANGE_RE = new RegExp('^(' + MONTH + ')\\w*\\.?\\s+\\d{1,2},\\s+\\d{4}\\s*-\\s*(' + MONTH + ')\\w*\\.?\\s+\\d{1,2},\\s+\\d{4}$', 'i');
const SINGLE_DATE_RE = new RegExp('^([A-Za-z]{2,4}\\.?\\s+)?(' + MONTH + ')\\w*\\.?\\s+\\d{1,2},\\s+\\d{4}$', 'i');
const TIME_RE = /^\d{1,2}:\d{2}\s*(AM|PM)\b/i;
const PLAYERS_RE = /^\d+\s+Players?$/i;
const CITY_REGION_RE = /^[^,]+,\s*.+$/; // "City, Region" -- loose, region isn't always a 2-letter US state
const ADDRESS_RE = /\d{1,6}\s+\S+\s+\S+/; // a street number followed by a multi-word street name, anywhere in the line (not anchored to the start, since some venues prefix the line with "Suite X, ") -- still excludes single-word false positives like "45 Minutes" (duration) or "32 Capacity" since those only have one word after the number
const NOT_ADDRESS_RE = /\b(minutes?|mins?|hours?|hrs?|capacity|players?)\b/i; // extra safety net against the same class of false positive

// Some venue detail pages show a short address subtitle followed by the
// full address right after it, and since our line detection just grabs
// whichever line matches ADDRESS_RE first, the two can end up concatenated
// into one garbled string with everything repeated (confirmed live:
// "suite 7, 2177, Kingsley Ave 2177 Kingsley Ave #7, suite 7 Orange Park FL
// 32073"). If the street number shows up a second time later in the
// string, treat everything from that second occurrence onward as the real,
// more complete address and drop the duplicated prefix.
function cleanupAddress(addr) {
  if (!addr) return addr;
  const numMatch = addr.match(/\b(\d{2,6})\b/);
  if (!numMatch) return addr;
  const num = numMatch[1];
  const firstIdx = addr.indexOf(num);
  const secondIdx = addr.indexOf(num, firstIdx + num.length);
  if (secondIdx > 0) return addr.slice(secondIdx).trim();
  return addr;
}
const STATUS_RE = /^(Complete|Completed|Upcoming|Cancelled|Canceled|In Progress|Live)$/i;
// Anything that isn't strictly in the future -- already finished, cancelled,
// or actively happening right now -- gets excluded from "upcoming".
const NOT_UPCOMING_STATUS_RE = /^(Complete|Completed|Cancelled|Canceled|In Progress|Live)$/i;

function parseDate(str) {
  const d = new Date(str.trim());
  return isNaN(d.getTime()) ? null : d;
}

// Extracts one event's fields from the lines surrounding a date match at
// index `i` (name is 3 lines before it: name, status, location, date...).
function extractFromListing(lines, i) {
  const dateLine = lines[i];
  const isRange = DATE_RANGE_RE.test(dateLine);

  let startDate = null, endDate = null;
  if (isRange) {
    const [startStr, endStr] = dateLine.split(/\s*-\s*/);
    startDate = parseDate(startStr);
    endDate = parseDate(endStr);
  } else {
    // Strip a leading weekday abbreviation e.g. "Thu. " before parsing.
    endDate = parseDate(dateLine.replace(/^[A-Za-z]{2,4}\.?\s+/, ''));
    startDate = endDate;
  }

  const name = lines[i - 3] || '';
  const status = lines[i - 2] || '';
  const location = CITY_REGION_RE.test(lines[i - 1] || '') ? lines[i - 1] : '';
  const cityMatch = location.match(/^([^,]+),\s*(.+)$/);

  let j = i + 1;
  const time = TIME_RE.test(lines[j] || '') ? lines[j] : '';
  if (time) j++;
  if (PLAYERS_RE.test(lines[j] || '')) j++; // skip player count if present
  const storeName = lines[j] || '';
  const type = lines[j + 1] || '';
  const price = lines[j + 2] || '';

  return {
    name,
    status,
    isRange,
    location,
    city: cityMatch ? cityMatch[1].trim() : '',
    state: cityMatch ? cityMatch[2].trim() : '',
    dateDisplay: dateLine,
    startDate,
    endDate,
    time,
    storeName,
    price,
    type
  };
}

// For single-date events, trust the site's own explicit status directly.
// For recurring date-range events, status describes the reference
// occurrence rather than the series -- use the range's end date instead.
function isUpcoming(e, todayStart) {
  if (!e.isRange && e.status && STATUS_RE.test(e.status)) {
    return !NOT_UPCOMING_STATUS_RE.test(e.status);
  }
  if (!e.endDate) return true; // can't determine -- fail open
  return e.endDate.getTime() >= todayStart.getTime();
}

// The listing page only renders a small initial batch of events -- the rest
// requires clicking "Load Newer" repeatedly, which appends more events to
// the same page (confirmed live: the button text is exactly "Load Newer").
// Without this, the scraped set is really just whatever handful of events
// Play Network happened to list first (observed: essentially random
// worldwide locations, not anchored to any particular region), so
// location-based filtering downstream could easily come up empty even when
// real nearby events exist -- they just never made it into events.json.
//
// The button isn't present in the DOM until scrolled near the bottom (a
// live diagnostic run showed 0 clicks even after programmatic scrollTo --
// the button simply never mounted), so each iteration does a real
// mouse-wheel scroll (many infinite-scroll/virtualization libraries only
// react to genuine scroll gestures, not scrollTo) and also scrolls any
// nested scrollable container on the page, in case the list scrolls inside
// its own div rather than the window.
async function loadMoreEvents(page, maxClicks) {
  let clicks = 0;
  for (let i = 0; i < maxClicks; i++) {
    await page.mouse.wheel(0, 4000);
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      document.querySelectorAll('*').forEach(el => {
        if (el.scrollHeight > el.clientHeight + 50) el.scrollTop = el.scrollHeight;
      });
    });
    await page.waitForTimeout(700); // give the lazy-mounted button a moment to appear
    const clicked = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const btn = els.find(el =>
        el.textContent && el.textContent.trim() === 'Load Newer' &&
        el.offsetParent !== null
      );
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) {
      if (i === 0) {
        // Diagnostic fallback: if it fails on the very first attempt, dump
        // anything on the page that mentions "load" so the next round has
        // real data instead of another blind guess at the button's shape.
        const hints = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          return els
            .filter(el => el.textContent && /load/i.test(el.textContent))
            .map(el => ({ tag: el.tagName, text: el.textContent.trim().slice(0, 60), visible: el.offsetParent !== null }));
        });
        console.log('No "Load Newer" found after scrolling. Load-related elements on page:', JSON.stringify(hints, null, 2));
      }
      break;
    }
    clicks++;
    await page.waitForTimeout(1200); // let the newly appended events render before the next click
  }
  console.log('Clicked "Load Newer" ' + clicks + ' time(s) to expand the event pool.');
}

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Fetching ' + EVENTS_URL + '...');
  await page.goto(EVENTS_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.waitForSelector('a[href*="/events/"]', { timeout: 15000 }).catch(() => {});
  await loadMoreEvents(page, 40);

  const { parsed, urlsInOrder, listDiagnostics } = await page.evaluate(({ rangePattern, singlePattern }) => {
    const dateRangeRe = new RegExp(rangePattern, 'i');
    const singleDateRe = new RegExp(singlePattern, 'i');
    const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);

    // Collect event URLs in document order (top to bottom), NOT keyed by
    // event name -- matching by name silently collided whenever two
    // different events shared a generic name (confirmed live: two separate
    // "Monday Sorcery" events, one in Marietta GA and one in Nashville TN,
    // ended up with the identical URL and address because the second
    // lookup by name just returned the first match). Event cards and their
    // date-line text both appear in the same top-to-bottom document order,
    // so pairing stub[k] with urlsInOrder[k] by position avoids the
    // collision entirely.
    const urlsInOrder = [];
    const seenUrls = new Set();
    Array.from(document.querySelectorAll('a[href*="/events/"]')).forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!href || href === '/events' || href.startsWith('/events?')) return;
      const url = href.startsWith('http') ? href : 'https://play.sorcerytcg.com' + href;
      if (seenUrls.has(url)) return; // same card can have multiple links (image + title) to the same URL
      seenUrls.add(url);
      urlsInOrder.push(url);
    });

    const dateIndexes = [];
    lines.forEach((l, idx) => {
      if (dateRangeRe.test(l) || singleDateRe.test(l)) dateIndexes.push(idx);
    });

    return {
      parsed: { lines, dateIndexes },
      urlsInOrder,
      listDiagnostics: {
        totalEventLinks: seenUrls.size,
        dateLinesFound: dateIndexes.length,
        bodyTextSample: document.body.innerText.slice(0, 1200)
      }
    };
  }, { rangePattern: DATE_RANGE_RE.source, singlePattern: SINGLE_DATE_RE.source });

  console.log('List page diagnostics:', JSON.stringify(listDiagnostics, null, 2));

  if (!listDiagnostics.dateLinesFound) {
    await browser.close();
    console.error('No date patterns found on the listing page -- page structure may have changed. See diagnostics above.');
    fs.writeFileSync('events.json', JSON.stringify({ updated: new Date().toISOString(), events: [] }, null, 2));
    process.exit(1);
  }

  if (urlsInOrder.length !== parsed.dateIndexes.length) {
    console.log('WARNING: found ' + urlsInOrder.length + ' event links but ' + parsed.dateIndexes.length + ' event entries -- positional URL matching may be misaligned for some events this run.');
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const stubs = parsed.dateIndexes
    .map((i, k) => ({ ...extractFromListing(parsed.lines, i), url: urlsInOrder[k] || '' }))
    .filter(e => e.name);

  console.log('Parsed ' + stubs.length + ' events from the listing page.');

  const upcoming = stubs.filter(e => isUpcoming(e, todayStart));
  const skipped = stubs.length - upcoming.length;
  console.log('Filtered out ' + skipped + ' completed/ended event(s). Keeping ' + upcoming.length + '.');

  console.log('Visiting up to ' + MAX_DETAIL_VISITS + ' detail pages for street addresses...');

  let geocodeCache = {};
  try {
    geocodeCache = JSON.parse(fs.readFileSync(GEOCODE_STATE_FILE, 'utf8'));
    console.log('Loaded ' + Object.keys(geocodeCache).length + ' cached city/state geocodes from ' + GEOCODE_STATE_FILE);
  } catch (e) {
    console.log('No existing ' + GEOCODE_STATE_FILE + ' -- geocoding all cities fresh');
  }

  const events = [];
// The rendered listing-page text only shows a rounded UTC start time, and
// no end time at all. The page's detail view actually displays both start
// and end in the venue's own local timezone (confirmed live via
// screenshot: "6:30 PM EDT" / "10:30 PM EDT") -- and both the precise ISO
// timestamps AND the venue's IANA timezone (e.g. "America/New_York") are
// available in Next.js's own RSC JSON payload embedded in the page
// (page.content(), not innerText). Using that directly gives DST-aware,
// venue-local times matching the site's own display, rather than the raw
// UTC values.
async function extractEventTimes(html, eventId) {
  if (!eventId || !html) return { start: '', end: '' };
  try {
    // The event data lives inside a <script>self.__next_f.push([1,"..."])</script>
    // tag -- the JSON is serialized as a JS string literal argument, so its
    // internal quotes are backslash-escaped (\"id\":\"...\") in the raw HTML
    // text rather than plain ("id":"..."). Unescape those first so the
    // regexes below (written against plain JSON quoting) actually match.
    const unescaped = html.replace(/\\"/g, '"');
    const idIdx = unescaped.indexOf('"id":"' + eventId + '"');
    if (idIdx < 0) return { start: '', end: '' };
    const windowText = unescaped.slice(Math.max(0, idIdx - 500), idIdx + 1500);
    const startM = windowText.match(/"startsAt":"([^"]+)"/);
    const endM = windowText.match(/"endsAt":"([^"]+)"/);
    const tzM = windowText.match(/"timezone":"([^"]+)"/) || unescaped.match(/"timezone":"([^"]+)"/);
    const tz = tzM ? tzM[1] : 'UTC';
    function fmt(iso) {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      try {
        return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }).format(d);
      } catch (e) {
        return '';
      }
    }
    return { start: startM ? fmt(startM[1]) : '', end: endM ? fmt(endM[1]) : '' };
  } catch (e) {
    return { start: '', end: '' };
  }
}

  let sampleLogged = false;

  for (let i = 0; i < upcoming.length; i++) {
    const e = upcoming[i];
    let address = '';
    let duration = '';
    let startTime = e.time; // UTC text scraped from the listing page -- fallback if the JSON lookup below fails
    let endTime = '';

    if (e.url && i < MAX_DETAIL_VISITS) {
      try {
        const resp = await page.goto(e.url, { waitUntil: 'networkidle', timeout: 20000 });
        const rawHtml = resp ? await resp.text() : '';
        await page.waitForTimeout(1000);
        const detailLines = await page.evaluate(() =>
          document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean)
        );
        const addrLine = detailLines.find(l => ADDRESS_RE.test(l) && !NOT_ADDRESS_RE.test(l) && !TIME_RE.test(l));
        if (addrLine) address = cleanupAddress(addrLine);
        const durLine = detailLines.find(l => /^\d+\s*(minutes?|mins?)$/i.test(l) || /round\s*length/i.test(l));
        if (durLine) duration = durLine;

        const eventIdMatch = e.url.match(/\/events\/([a-f0-9-]+)/i);
        if (eventIdMatch) {
          const times = await extractEventTimes(rawHtml, eventIdMatch[1]);
          if (times.start) startTime = times.start;
          if (times.end) endTime = times.end;
          if (!sampleLogged) console.log('Time extraction for first event:', JSON.stringify(times));
        }

        if (!sampleLogged) {
          console.log('Sample detail page lines (first event, for debugging):', JSON.stringify(detailLines.slice(0, 20), null, 2));
          sampleLogged = true;
        }
      } catch (err) {
        console.log('  [' + e.name + '] detail page failed -- ' + err.message);
      }
    }

    const geo = await geocode(e.city, e.state, geocodeCache);

    events.push({
      name: e.name,
      date: e.dateDisplay,
      time: startTime,
      endTime,
      type: e.type,
      price: e.price,
      duration,
      location: e.location,
      city: e.city,
      state: e.state,
      lat: geo ? geo.lat : null,
      lng: geo ? geo.lng : null,
      address,
      description: '',
      storeName: e.storeName,
      url: e.url
    });
  }

  fs.writeFileSync(GEOCODE_STATE_FILE, JSON.stringify(geocodeCache, null, 2));

  await browser.close();

  const output = {
    updated: new Date().toISOString(),
    source: EVENTS_URL,
    events
  };

  fs.writeFileSync('events.json', JSON.stringify(output, null, 2));
  console.log('Done -- scraped ' + events.length + ' upcoming events to events.json');

  // Notify about genuinely new events, grouped by store (one notification
  // per store with new events, not one per event, to avoid spamming
  // someone's device if a store adds several events in one scrape cycle).
  // Skipped on the very first run ever (no prior state to compare against,
  // same reasoning as the other scrapers' notification logic).
  let seenUrls = [];
  let isFirstRun = true;
  try {
    seenUrls = JSON.parse(fs.readFileSync(SEEN_STATE_FILE, 'utf8')).urls || [];
    isFirstRun = false;
  } catch (e) {
    console.log('No existing ' + SEEN_STATE_FILE + ' -- first run, will not notify');
  }
  const seenSet = new Set(seenUrls);
  const newEvents = events.filter(e => e.url && !seenSet.has(e.url));

  fs.writeFileSync(SEEN_STATE_FILE, JSON.stringify({ urls: events.map(e => e.url).filter(Boolean) }, null, 2));

  if (isFirstRun || !newEvents.length) {
    console.log(isFirstRun ? 'First run -- not sending store notifications.' : 'No new events since last run.');
  } else {
    const byStore = {};
    newEvents.forEach(e => {
      const key = e.storeName || 'Unknown Store';
      (byStore[key] = byStore[key] || []).push(e);
    });
    try {
      const admin = require('firebase-admin');
      if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      }
      for (const storeName of Object.keys(byStore)) {
        const topic = storeTopicName(storeName);
        if (!topic) continue;
        const evs = byStore[storeName];
        const first = evs[0];
        const title = 'New event at ' + storeName;
        const body = evs.length === 1 ? first.name : evs.length + ' new events, including ' + first.name;
        try {
          await admin.messaging().send({
            topic,
            notification: { title, body },
            android: { priority: 'high' },
            webpush: { headers: { Urgency: 'high' }, fcmOptions: { link: first.url } }
          });
          console.log('Sent FCM notification to store topic "' + topic + '" (' + evs.length + ' new event(s)).');
        } catch (e) {
          console.log('FCM notification failed for store "' + storeName + '" (non-fatal): ' + e.message);
        }
      }
    } catch (e) {
      console.log('FCM setup failed (non-fatal): ' + e.message);
    }
  }
})();
