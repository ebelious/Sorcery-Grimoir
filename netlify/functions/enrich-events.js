// On-demand enrichment for Sorcery Play Network events -- fills in the
// fields the periodic scraper (scrape-events.js) intentionally leaves
// blank: address, duration, endTime, and the venue-local (not UTC) start
// time/date. Those all require visiting each event's own detail page,
// which isn't feasible for all ~3,000 events on every periodic run -- so
// instead this runs only for the handful of events actually near a user's
// search (called from the app right after it filters events.json down to
// nearby results), keeping this fast and cap-free for what actually
// matters to that search.
//
// No browser/Playwright needed: the data lives in Next.js's own
// server-rendered RSC JSON payload, embedded directly in the HTML a plain
// fetch() already returns (confirmed live -- this is the same data
// page.content() would show after full hydration, just without needing a
// browser to get there).
//
// Request:  POST { events: [{url, name}, ...] }
//   name is used to disambiguate the correct event object on the page when
//   multiple candidates share the requested id (confirmed live -- without
//   this, results can silently pick up an unrelated event's timestamps).
//   Capped at MAX_URLS per request -- the app should only ever send the
//   small set of events actually near a search, not the whole event list.
// Response: { results: { "<url>": {address, duration, endTime, time, date}, ... } }
//   Any URL that fails to fetch/parse is simply omitted from results
//   rather than failing the whole request.
//
// SECURITY: item.url is attacker-controlled (it comes straight from the
// POST body) and this function fetch()es it server-side from Netlify's own
// network context. The only prior validation was a path-shape regex
// (/\/events\/[a-f0-9-]+/), which never checked the *hostname* -- a URL
// like "http://169.254.169.254/events/<uuid>" or one pointing at an
// internal service would have passed that check and been fetched from
// here, which is a server-side request forgery (SSRF) hole. isAllowedUrl()
// below enforces an explicit hostname allowlist (only the real Play
// Network host, over https) before any fetch happens, independent of and
// in addition to the existing path-shape check.

const MAX_URLS = 40;
const ALLOWED_HOSTS = new Set(['play.sorcerytcg.com']);

function isAllowedUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return false;
  }
  return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname.toLowerCase());
}

function resp(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(obj)
  };
}

// The event data lives inside a <script>self.__next_f.push([1,"..."])</script>
// tag -- the JSON is serialized as a JS string literal argument, so its
// internal quotes are backslash-escaped (\"id\":\"...\") in the raw HTML
// text rather than plain ("id":"..."). Unescape those first so the plain-
// JSON-quoting regexes below actually match.
function unescapeHtml(html) {
  return html.replace(/\\"/g, '"');
}

function extractEventDetails(html, eventId, eventName) {
  const out = { address: '', duration: '', time: '', endTime: '', date: '' };
  if (!eventId || !html) return out;
  const unescaped = unescapeHtml(html);

  // Address: a single event detail page has one primary venue address
  // (address1/address2/city/state/zip), regardless of how many other
  // unrelated objects are on the page -- address2 is the fuller,
  // better-formatted line when present (confirmed live: address1 was the
  // messier "suite 7, 2177, Kingsley Ave" while address2 was the clean
  // "2177 Kingsley Ave #7, suite 7").
  const a1M = unescaped.match(/"address1":"([^"]*)"/);
  const a2M = unescaped.match(/"address2":"([^"]*)"/);
  const cityM = unescaped.match(/"city":"([^"]*)"/);
  const stateM = unescaped.match(/"state":"([^"]*)"/);
  const zipM = unescaped.match(/"zip":"([^"]*)"/);
  const line = (a2M && a2M[1]) ? a2M[1] : (a1M ? a1M[1] : '');
  out.address = [line, cityM ? cityM[1] : '', stateM ? stateM[1] : '', zipM ? zipM[1] : '']
    .filter(Boolean).join(' ').trim();

  // Start/end/date: earlier versions searched a wide text window for
  // "startsAt" and "endsAt" independently, which could pair a start from
  // one nearby object with an end from a completely different one --
  // confirmed live twice: once as literally reversed times, once as a
  // multi-week date range (matching a recurring series' first and last
  // occurrences, not the one specific date this URL is actually for).
  // Requiring startsAt/endsAt/name to all come from the exact same flat
  // object as this event's id (stopping at the first { or } after id, so
  // the match can't cross into an unrelated adjacent object) fixes both.
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  const objRe = new RegExp('"id":"' + escapeRe(eventId) + '"([^{}]*)', 'g');
  let best = null;
  let m;
  while ((m = objRe.exec(unescaped)) !== null) {
    const tail = m[1];
    const startM = tail.match(/"startsAt":"([^"]+)"/);
    const endM = tail.match(/"endsAt":"([^"]+)"/);
    if (!startM || !endM) continue;
    const hasName = !!(eventName && tail.indexOf('"name":"' + eventName + '"') >= 0);
    const entryM = tail.match(/"entryTime":(\d+)/);
    const candidate = { startM, endM, entryM, hasName };
    // Prefer a candidate whose object also contains this event's own name;
    // otherwise keep the first valid start/end pairing found.
    if (!best || (hasName && !best.hasName)) best = candidate;
  }

  if (best) {
    const startM = best.startM, endM = best.endM, entryM = best.entryM;
    const tzM = unescaped.match(/"timezone":"([^"]+)"/);
    const tz = tzM ? tzM[1] : 'UTC';

    function fmtTime(iso) {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      try {
        return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }).format(d);
      } catch (e) {
        return '';
      }
    }
    function fmtDate(iso) {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      try {
        return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
      } catch (e) {
        return '';
      }
    }

    if (startM) out.time = fmtTime(startM[1]);
    if (endM) out.endTime = fmtTime(endM[1]);
    if (startM && endM) {
      // The listing page's date range is UTC-day-boundary based, so a
      // single local evening that crosses UTC midnight (e.g. 6:30-10:30 PM
      // EDT = 10:30 PM-2:30 AM UTC) can look like a 2-day span there.
      // Collapse back to one date when start/end share a local calendar day.
      const sd = fmtDate(startM[1]), ed = fmtDate(endM[1]);
      if (sd && ed) out.date = sd === ed ? sd : (sd + ' - ' + ed);
    }
    if (entryM) out.duration = entryM[1] + ' Minutes';
  }

  return out;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method Not Allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return resp(400, { error: 'Invalid JSON body' });
  }

  // Accepts either { events: [{url, name}, ...] } (name used to
  // disambiguate the correct object when a page has multiple candidates)
  // or the older { urls: [...] } shape (name omitted, falls back to a
  // last-occurrence heuristic).
  let items = [];
  if (Array.isArray(body.events)) {
    items = body.events.filter(e => e && typeof e.url === 'string').slice(0, MAX_URLS);
  } else if (Array.isArray(body.urls)) {
    items = body.urls.filter(u => typeof u === 'string').slice(0, MAX_URLS).map(url => ({ url, name: '' }));
  }
  if (!items.length) return resp(400, { error: 'No events/urls provided' });

  const results = {};
  await Promise.all(items.map(async (item) => {
    try {
      // Hostname allowlist check FIRST -- see the SECURITY note at the top
      // of this file. This must run before anything else touches item.url,
      // and independently of the path-shape regex below (which only ever
      // checked the path, never the host).
      if (!isAllowedUrl(item.url)) return;
      const idMatch = item.url.match(/\/events\/([a-f0-9-]+)/i);
      if (!idMatch) return;
      const res = await fetch(item.url, { headers: { 'User-Agent': 'Sorcery-Grimoir-EventEnrich/1.0' } });
      if (!res.ok) return;
      const html = await res.text();
      results[item.url] = extractEventDetails(html, idMatch[1], item.name || '');
    } catch (e) {
      // Skip this one URL -- one failure shouldn't fail the whole batch.
    }
  }));

  return resp(200, { results });
};
