const { chromium } = require('playwright');
const fs = require('fs');

const CODEX_URL = 'https://curiosa.io/codex';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // ── Intercept every response that could carry codex/FAQ data ──────────────
  // Confirmed the backend is Sanity CMS (fields like _id/_type/_createdAt),
  // whose generic query API domain (sanity.io / apicdn.sanity.io) won't
  // necessarily have "codex" or "faq" in the URL itself — only in the GROQ
  // query text — so match on that domain too, not just keyword URLs.
  const rawResponses = [];
  const rawUrls = [];
  // Sanity's image CDN URLs need the project ID + dataset, which live in the
  // query API's own URL (https://<projectId>.apicdn.sanity.io/.../data/query/<dataset>?...).
  // Capture them from whatever Sanity request we see so we can build real
  // image URLs from the asset references embedded in portable text blocks.
  let sanityProjectId = null;
  let sanityDataset = null;
  page.on('response', async (response) => {
    const url = response.url();
    if (!sanityProjectId) {
      const m = url.match(/https?:\/\/([a-z0-9]+)\.api(?:cdn)?\.sanity\.io\/v\d[\w-]*\/data\/query\/([a-z0-9_-]+)/i);
      if (m) { sanityProjectId = m[1]; sanityDataset = m[2]; }
    }
    if (!/codex|faq|glossary|rules|sanity/i.test(url)) return;
    try {
      const json = await response.json();
      rawResponses.push(json);
      rawUrls.push(url);
    } catch (e) {}
  });

  function lower(s) { return (s || '').toString().toLowerCase(); }

  // Sanity image asset refs look like "image-<hash>-<width>x<height>-<format>".
  // Convert one into a real CDN URL once we know the project/dataset.
  function sanityAssetUrl(ref) {
    if (!ref || !sanityProjectId || !sanityDataset) return '';
    const m = String(ref).match(/^image-([a-f0-9]+)-(\d+x\d+)-(\w+)$/i);
    if (!m) return '';
    return `https://cdn.sanity.io/images/${sanityProjectId}/${sanityDataset}/${m[1]}-${m[2]}.${m[3]}`;
  }

  var _loggedImageSample = false;
  var _loggedTableSample = false;
  var _loggedRefSample = false;
  // Sanity stores rich text as "Portable Text": an array of block objects,
  // each with a `children` array of spans carrying the actual `text` — or,
  // for embedded diagrams/graphics, a block with `_type:'image'` and an
  // `asset._ref` pointing at the image, OR (confirmed from a real example: a
  // 3x3 numbered site grid) a `_type:'table'`-style block with row/cell data
  // that the frontend renders as an actual HTML <table>, not an image. Card
  // name cross-references (rendered as clickable buttons on curiosa) are
  // confirmed to be inline non-text objects within `children` — they lack a
  // `.text` field, so their name is pulled from whichever field actually
  // holds it, with a few plausible names tried since the exact one hasn't
  // been confirmed yet.
  function _inlineChildText(c) {
    if (!c) return '';
    if (typeof c.text === 'string') return c.text;
    var name = c.cardName || c.card || c.name || c.title || c.value || c.label;
    if (typeof name === 'string') return name;
    if (!_loggedRefSample) {
      _loggedRefSample = true;
      console.log('Sample non-text inline child (for debugging card-reference field mapping):');
      console.log(JSON.stringify(c, null, 2));
    }
    return '';
  }
  // Builds a formatted run { text, bold, italic, cardRef } from an inline
  // child instead of collapsing straight to plain text, so bold/italic marks
  // and card cross-references survive into the app for real rendering.
  function _runFromChild(c, markDefsByKey) {
    if (!c) return null;
    if (typeof c.text === 'string') {
      const marks = Array.isArray(c.marks) ? c.marks : [];
      const isLink = !!markDefsByKey && marks.some(mk => {
        const def = markDefsByKey[mk];
        return def && (def._type === 'link' || def.href);
      });
      return { text: c.text, bold: marks.includes('strong'), italic: marks.includes('em'), link: isLink };
    }
    const name = c.cardName || c.card || c.name || c.title || c.value || c.label;
    if (typeof name === 'string') return { text: name, cardRef: name };
    if (!_loggedRefSample) {
      _loggedRefSample = true;
      console.log('Sample non-text inline child (for debugging card-reference field mapping):');
      console.log(JSON.stringify(c, null, 2));
    }
    return null;
  }
  function portableTextToPlain(val) {
    if (typeof val === 'string') return val.trim();
    if (!Array.isArray(val)) return '';
    return val.map(block => {
      if (!block) return '';
      if (typeof block === 'string') return block;
      if (Array.isArray(block.children)) {
        return block.children.map(_inlineChildText).join('');
      }
      return block.text || '';
    }).join('\n').trim();
  }

  // Walks the block array in original document order and returns a mixed
  // sequence of segments — { t:'p', text, runs } for paragraphs (runs
  // preserve bold/italic and card-reference links), { t:'h', text, runs }
  // for short bold standalone lines (e.g. "Example 1"), { t:'tbl', rows }
  // for grids, { t:'img', url } for images — so tables/images render at the
  // exact position they appear in the source text instead of all at the end.
  // Each source paragraph block becomes its own segment (matching curiosa's
  // own per-<p> structure) rather than merging consecutive ones together.
  function portableTextSegments(val) {
    if (!Array.isArray(val)) return [];
    const segs = [];
    val.forEach(block => {
      if (!block || typeof block !== 'object') return;
      const isTable = /table|grid/i.test(block._type || '');
      const isImageBlock = (block._type === 'image' || block._type === 'figure' || !!block.asset) && !isTable;

      if (isTable) {
        if (!_loggedTableSample) {
          _loggedTableSample = true;
          console.log('Sample portable-text table block (for debugging table field mapping):');
          console.log(JSON.stringify(block, null, 2));
        }
        const rowsRaw = block.grid?.rows || block.rows || block.table?.rows || block.data;
        if (Array.isArray(rowsRaw)) {
          const grid = rowsRaw.map(row => {
            const cellsRaw = Array.isArray(row) ? row : (row && (row.cells || row.row));
            if (!Array.isArray(cellsRaw)) return [];
            return cellsRaw.map(cell => {
              if (typeof cell === 'string') return cell;
              if (cell && typeof cell === 'object') {
                return portableTextToPlain(cell.content || cell.text || cell.children || [cell]) || (cell.text || '');
              }
              return String(cell ?? '');
            });
          }).filter(row => row.length);
          if (grid.length) segs.push({ t: 'tbl', rows: grid });
        }
        return;
      }

      if (isImageBlock) {
        if (!_loggedImageSample) {
          _loggedImageSample = true;
          console.log('Sample portable-text image block (for debugging image field mapping):');
          console.log(JSON.stringify(block, null, 2));
        }
        const ref = block.asset && (block.asset._ref || block.asset.ref);
        const url = sanityAssetUrl(ref);
        if (url) segs.push({ t: 'img', url });
        return;
      }

      if (Array.isArray(block.children)) {
        const markDefsByKey = {};
        (block.markDefs || []).forEach(md => { if (md && md._key) markDefsByKey[md._key] = md; });
        const runs = block.children.map(c => _runFromChild(c, markDefsByKey)).filter(Boolean);
        const text = runs.map(r => r.text).join('').trim();
        if (!text) return;
        const isBoldHeading = runs.length === 1 && runs[0].bold && !runs[0].cardRef && text.length < 60;
        const prefix = block.listItem === 'bullet' ? '• ' : '';
        if (prefix && runs.length) runs[0] = Object.assign({}, runs[0], { text: prefix + runs[0].text });
        segs.push({ t: isBoldHeading ? 'h' : 'p', text: prefix + text, runs });
      }
    });
    return segs;
  }

  function portableTextImages(val) {
    if (!Array.isArray(val)) return [];
    const urls = [];
    val.forEach(block => {
      if (!block || typeof block !== 'object') return;
      const isImage = block._type === 'image' || block._type === 'figure' || !!block.asset;
      const ref = block.asset && (block.asset._ref || block.asset.ref);
      if (isImage && ref) {
        if (!_loggedImageSample) {
          _loggedImageSample = true;
          console.log('Sample portable-text image block (for debugging image field mapping):');
          console.log(JSON.stringify(block, null, 2));
        }
        const url = sanityAssetUrl(ref);
        if (url) urls.push(url);
      }
    });
    return urls;
  }
  // Extracts grid/table blocks as a 2D array of cell text, e.g.
  // [["1","2","3"],["4","5","6"],["7","8","9"]]. Handles a few plausible
  // Sanity table-plugin shapes since the exact one hasn't been confirmed yet.
  function portableTextTables(val) {
    if (!Array.isArray(val)) return [];
    const tables = [];
    val.forEach(block => {
      if (!block || typeof block !== 'object') return;
      const isTable = /table|grid/i.test(block._type || '');
      if (!isTable) return;
      if (!_loggedTableSample) {
        _loggedTableSample = true;
        console.log('Sample portable-text table block (for debugging table field mapping):');
        console.log(JSON.stringify(block, null, 2));
      }
      let rowsRaw = block.grid?.rows || block.rows || block.table?.rows || block.data;
      if (!Array.isArray(rowsRaw)) return;
      const grid = rowsRaw.map(row => {
        const cellsRaw = Array.isArray(row) ? row : (row && (row.cells || row.row));
        if (!Array.isArray(cellsRaw)) return [];
        return cellsRaw.map(cell => {
          if (typeof cell === 'string') return cell;
          if (cell && typeof cell === 'object') {
            return portableTextToPlain(cell.content || cell.text || cell.children || [cell]) || (cell.text || '');
          }
          return String(cell ?? '');
        });
      }).filter(row => row.length);
      if (grid.length) tables.push(grid);
    });
    return tables;
  }

  // ── Shape detection ─────────────────────────────────────────────────────
  function looksLikeCodex(o) {
    if (!o || typeof o !== 'object') return false;
    if (o._type && /codex|glossary|term|keyword/i.test(o._type)) return true;
    return !!(o.k || o.keyword || o.term || o.title || o.name)
      && (o.def !== undefined || o.definition !== undefined || o.text !== undefined || o.content !== undefined || o.description !== undefined);
  }
  function looksLikeFaq(o) {
    if (!o || typeof o !== 'object') return false;
    if (o._type && /faq/i.test(o._type)) return true;
    return !!(o.q || o.question) && !!(o.a || o.answer);
  }

  function normCodex(o) {
    const kRaw = o.k || o.keyword || o.term || o.title || o.name;
    const defRaw = o.def || o.definition || o.text || o.content || o.description;
    const k = portableTextToPlain(kRaw);
    const def = portableTextToPlain(defRaw);
    if (!k || !def) return null;
    let segments = portableTextSegments(defRaw);
    if (Array.isArray(o.subcodexes)) {
      o.subcodexes.forEach(sc => {
        if (sc && Array.isArray(sc.content)) {
          if (sc.title) segments.push({ t: 'h', text: sc.title });
          segments = segments.concat(portableTextSegments(sc.content));
        }
      });
    }
    return { k, def, sub: portableTextToPlain(o.sub || o.subDef) || '', id: o._id || o.id || '', segments: segments.length ? segments : undefined };
  }

  // Returns an array — a Sanity FAQ entry can apply to multiple cards via
  // cardNames, and the app's schema expects one { card, q, a } row per card.
  function normFaq(o, cardNameHint) {
    const qRaw = o.q || o.question;
    const aRaw = o.a || o.answer;
    const qText = portableTextToPlain(qRaw);
    const aText = portableTextToPlain(aRaw);
    if (!qText || !aText) return [];
    // The question's own plain text (q) is already shown as its own header
    // in the app, so only pull non-text segments (tables/images — e.g. the
    // oversized-minion grid example that lives inside the question) out of
    // it, not its paragraph text, to avoid the question being displayed
    // twice. The answer's segments are kept in full.
    const qSegs = portableTextSegments(qRaw).filter(s => s.t === 'tbl' || s.t === 'img');
    const segments = qSegs.concat(portableTextSegments(aRaw));
    let names = [];
    if (Array.isArray(o.cardNames) && o.cardNames.length) names = o.cardNames;
    else if (Array.isArray(o.cards) && o.cards.length) names = o.cards;
    else if (o.card || o.cardName || o.cardTitle) names = [o.card || o.cardName || o.cardTitle];
    else if (cardNameHint) names = [cardNameHint];
    else names = [''];
    const id = o._id || o.id || '';
    return names.map(nm => ({ card: nm || '', q: qText, a: aText, id: id, segments: segments.length ? segments : undefined }));
  }


  var _loggedSample = false;
  const codexByKey = new Map();
  const faqByKey = new Map();

  function absorb(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 16) return;
    if (Array.isArray(obj)) {
      if (obj.length && (looksLikeCodex(obj[0]) || looksLikeFaq(obj[0]))) {
        if (!_loggedSample) {
          _loggedSample = true;
          console.log('Sample raw codex/FAQ object (for debugging field mapping):');
          console.log(JSON.stringify(obj[0], null, 2));
        }
        obj.forEach(item => {
          if (looksLikeFaq(item)) {
            normFaq(item).forEach(f => faqByKey.set((f.id ? f.id + '|' : '') + f.card + '|' + f.q, f));
          } else if (looksLikeCodex(item)) {
            const c = normCodex(item);
            if (c) codexByKey.set(c.id || c.k, c);
          } else if (item && Array.isArray(item.questions)) {
            // Possible card-grouped shape: { card, questions: [{q,a}, ...] }
            item.questions.forEach(sub => {
              normFaq(sub, item.card || item.name).forEach(f => faqByKey.set((f.id ? f.id + '|' : '') + f.card + '|' + f.q, f));
            });
          } else if (item && Array.isArray(item.faqs)) {
            item.faqs.forEach(sub => {
              normFaq(sub, item.card || item.name).forEach(f => faqByKey.set((f.id ? f.id + '|' : '') + f.card + '|' + f.q, f));
            });
          }
        });
      } else {
        obj.forEach(v => absorb(v, depth + 1));
      }
    } else {
      Object.values(obj).forEach(v => absorb(v, depth + 1));
    }
  }

  // ── Load page and scroll to trigger all lazy loads ────────────────────────
  console.log('Loading codex page...');
  await page.goto(CODEX_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  console.log(`After initial load: ${rawResponses.length} response(s) intercepted`);

  let scrollRounds = 0;
  let lastCount    = 0;
  let staleRounds  = 0;

  while (scrollRounds < 100 && staleRounds < 6) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const el = document.querySelector('main, [role="main"], .codex-list, #codex-list');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(600);

    const currentCount = rawResponses.length;
    if (currentCount === lastCount) {
      staleRounds++;
    } else {
      staleRounds = 0;
      console.log(`  Scroll round ${scrollRounds}: ${currentCount} responses (was ${lastCount})`);
    }
    lastCount = currentCount;
    scrollRounds++;
  }

  console.log(`\nDone scrolling. Total intercepted responses: ${rawResponses.length}`);
  console.log('Intercepted URLs:');
  rawUrls.forEach((u, i) => console.log(`  [${i}] ${u}`));

  for (const resp of rawResponses) {
    absorb(resp, 0);
  }

  const codex = Array.from(codexByKey.values());
  const faq = Array.from(faqByKey.values());
  console.log(`Codex entries: ${codex.length}`);
  console.log(`FAQ entries: ${faq.length}`);
  console.log(`Sanity project/dataset detected: ${sanityProjectId || '(none)'} / ${sanityDataset || '(none)'}`);
  console.log(`Codex entries with an image: ${codex.filter(c => c.segments && c.segments.some(s => s.t === 'img')).length}`);
  console.log(`FAQ entries with an image: ${faq.filter(f => f.segments && f.segments.some(s => s.t === 'img')).length}`);
  console.log(`Codex entries with a table: ${codex.filter(c => c.segments && c.segments.some(s => s.t === 'tbl')).length}`);
  console.log(`FAQ entries with a table: ${faq.filter(f => f.segments && f.segments.some(s => s.t === 'tbl')).length}`);

  const romEntry = codex.find(c => c.k === 'Range of Motion');
  if (romEntry) {
    console.log('\n"Range of Motion" extracted segments (for debugging heading/bold placement):');
    console.log(JSON.stringify(romEntry.segments, null, 2));
  } else {
    console.log('\n"Range of Motion" entry not found in scraped codex data.');
  }

  console.log('\nLoading codex changelog page...');
  let changelogEntries = [];
  try {
    await page.goto('https://curiosa.io/codex/changelog', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);
    const nextData = await page.evaluate(() => {
      try {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? JSON.parse(el.textContent) : null;
      } catch (e) { return null; }
    });
    if (nextData) {
      // Search the SSG-embedded page data for any portable-text block
      // arrays (same shape as codex/FAQ content), rather than assuming a
      // specific query key, since the changelog's exact data shape hasn't
      // been confirmed yet. Each block array is kept as its own separate
      // entry (not merged) so each change/update can be its own popup in
      // the app, and we grab the parent object alongside it to look for a
      // title/date field to label that entry with.
      const found = [];
      let excludedCount = 0;
      const seen = new Set();
      (function walk(node, parent, depth) {
        if (!node || typeof node !== 'object' || depth > 20) return;
        if (Array.isArray(node)) {
          if (node.length && node[0] && node[0]._type === 'block' && !seen.has(node)) {
            seen.add(node);
            // Skip content belonging to codex/FAQ documents — the changelog
            // page's embedded page data appears to still carry the full
            // codex/FAQ dataset (shared/cached across pages), and those
            // entries' own `content` fields also start with block-type
            // objects, so without this they'd get misidentified as
            // changelog entries too.
            const parentType = parent && parent._type;
            if (parentType !== 'codex' && parentType !== 'faq') {
              found.push({ blocks: node, parent });
            } else {
              excludedCount++;
            }
          }
          node.forEach(v => walk(v, node, depth + 1));
        } else {
          Object.keys(node).forEach(k => walk(node[k], node, depth + 1));
        }
      })(nextData, null, 0);
      console.log(`Changelog: excluded ${excludedCount} codex/FAQ content block(s) found alongside the changelog data.`);
      if (found.length) {
        const rejectedTitles = [];
        changelogEntries = found.map((f) => {
          const p = f.parent || {};
          const titleRaw = p.title || p.date || p.name || p.version || p._createdAt || p._updatedAt || '';
          const title = portableTextToPlain(titleRaw) || (typeof titleRaw === 'string' ? titleRaw : '');
          return { title, segments: portableTextSegments(f.blocks) };
        }).filter(e => {
          const isDate = !!e.title && !isNaN(Date.parse(e.title));
          if (e.segments.length && !isDate) rejectedTitles.push(e.title || '(blank)');
          return e.segments.length && isDate;
        });
        console.log(`Changelog: found ${changelogEntries.length} entr${changelogEntries.length === 1 ? 'y' : 'ies'} with a valid date title.`);
        if (rejectedTitles.length) {
          console.log(`Changelog: rejected ${rejectedTitles.length} entr${rejectedTitles.length === 1 ? 'y' : 'ies'} without a valid date title (likely codex/FAQ leakage), e.g.: ${rejectedTitles.slice(0, 5).join(', ')}`);
        }
        if (changelogEntries[0]) {
          console.log('Sample changelog entry (for debugging title/field mapping):');
          console.log(JSON.stringify({ title: changelogEntries[0].title }, null, 2));
        }
      } else {
        console.log('Changelog: no portable-text block array found in __NEXT_DATA__.');
      }
    } else {
      console.log('Changelog: could not read __NEXT_DATA__ from the page.');
    }
  } catch (e) {
    console.log('Changelog: failed to load/parse changelog page: ' + e.message);
  }

  await browser.close();

  if (!codex.length && !faq.length) {
    console.error('No codex or FAQ entries scraped.');
    process.exit(1);
  }

  codex.sort((a, b) => a.k.localeCompare(b.k));

  fs.writeFileSync(
    'codex.json',
    JSON.stringify({ updated: new Date().toISOString(), codex, faq }, null, 2)
  );
  console.log('✓ Wrote codex.json');

  fs.writeFileSync(
    'changelog.json',
    JSON.stringify({ updated: new Date().toISOString(), changelog: changelogEntries }, null, 2)
  );
  console.log('✓ Wrote changelog.json');
})();
