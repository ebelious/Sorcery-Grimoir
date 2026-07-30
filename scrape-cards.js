const { chromium } = require('playwright');
const fs = require('fs');

// Card library, sorted alphabetically so results are stable across runs
const CARDS_URL = 'https://curiosa.io/cards#search=eyJxdWVyeSI6IiIsInNldCI6IioiLCJmaWx0ZXJzIjpbXSwiY3NvcnQiOiJuYW1lIiwiZHNvcnQiOiJuYW1lIiwiZnNvcnQiOiJuYW1lIiwiZGl2aWRlciI6ImFsbCIsImF2YXRhciI6IioifQ==';

// Map curiosa's element/type/rarity labels to the short codes already
// used in index.html's CARDS array (el/t/r fields).
const EL_MAP = { air: 'air', earth: 'earth', fire: 'fire', water: 'water', elemental: 'neutral', none: 'neutral', neutral: 'neutral' };
const TYPE_MAP = { minion: 'minion', magic: 'magic', artifact: 'artifact', aura: 'aura', site: 'site', avatar: 'avatar' };
const RARITY_MAP = { ordinary: 'ordinary', exceptional: 'exceptional', elite: 'elite', unique: 'unique' };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // ── Intercept every card.search response ──────────────────────────────────
  const rawResponses = [];
  page.on('response', async (response) => {
    if (!response.url().includes('card.search')) return;
    try {
      const json = await response.json();
      rawResponses.push(json);
    } catch (e) {}
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function lower(s) { return (s || '').toString().toLowerCase(); }

  // A "complete" image slug looks like setcode-cardname-product-finish,
  // e.g. "got-abaddon_succubus-b-s" — four hyphen-separated parts, where
  // the first is a short (2-4 char) set code. A bare card slug like
  // "abaddon_succubus" or "got-abaddon_succubus" is NOT enough to build
  // a working images.sorcerycard.io URL.
  function looksComplete(slug) {
    if (!slug || typeof slug !== 'string') return false;
    const parts = slug.split('-');
    return parts.length >= 4 && parts[0].length <= 4;
  }

  function findFullSlug(item) {
    // 1) Top-level slug, if it's already complete.
    if (looksComplete(item.slug)) return item.slug;
    // 2) Look inside common nested collections of per-set printings.
    const buckets = [item.printings, item.editions, item.prints, item.versions, item.variants];
    for (const arr of buckets) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const withSlug = arr.find(p => looksComplete(p && (p.slug || p.imageSlug || p.fullSlug)));
      if (withSlug) return withSlug.slug || withSlug.imageSlug || withSlug.fullSlug;
    }
    // 3) Singular nested printing/card objects (some APIs nest one, not an array).
    const singles = [item.printing, item.card, item.defaultPrinting, item.primaryPrinting];
    for (const obj of singles) {
      if (obj && looksComplete(obj.slug || obj.imageSlug)) return obj.slug || obj.imageSlug;
    }
    // 4) Some APIs expose a direct imageSlug/fullSlug field.
    if (looksComplete(item.imageSlug)) return item.imageSlug;
    if (looksComplete(item.fullSlug)) return item.fullSlug;
    // 5) Give up — log it so we can see exactly what curiosa sent for this
    // card, and return whatever we have (may be partial) so the card still
    // shows up in search; _cm/click-through works regardless of the image.
    console.warn('Could not resolve a complete image slug for "' + (item.name || '?') + '" (type: ' + (item.type || item.category || '?') + '). Raw item:');
    console.warn(JSON.stringify(item, null, 2));
    return item.slug || '';
  }

  // Sites are rendered landscape on curiosa and are served from a different
  // CDN/path than every other card type (which use images.sorcerycard.io):
  //   https://d27a44hjr9gen3.cloudfront.net/rotated/{slug}.png
  // Confirmed from a real download: "999-overflowing_court-d-s.png".
  const SITE_CDN = 'https://d27a44hjr9gen3.cloudfront.net/rotated/';

  // curiosa serves images through Next.js's image proxy:
  //   https://curiosa.io/_next/image?url=<encoded-real-url>&w=...&q=...
  // Decode that wrapper down to the real CDN URL, same trick scrape-news.js
  // uses for article cover images.
  function unwrapNextImage(u) {
    if (!u || typeof u !== 'string') return u;
    try {
      const parsed = new URL(u, 'https://curiosa.io');
      const inner = parsed.searchParams.get('url');
      return inner ? decodeURIComponent(inner) : u;
    } catch (e) {
      return u;
    }
  }

  function findImageUrl(item, fullSlug, type) {
    // 1) A direct image URL field on the card itself, or nested printings.
    const direct = item.image || item.imageUrl || item.art || item.artUrl || item.artworkUrl;
    if (direct) return unwrapNextImage(direct);
    const buckets = [item.printings, item.editions, item.prints, item.versions, item.variants];
    for (const arr of buckets) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const withImg = arr.find(p => p && (p.image || p.imageUrl || p.art));
      if (withImg) return unwrapNextImage(withImg.image || withImg.imageUrl || withImg.art);
    }
    // 2) Sites: build the known rotated-CDN URL directly from the slug.
    if (type === 'site' && fullSlug) return SITE_CDN + fullSlug + '.png';
    // 3) Nothing found — index.html will fall back to its own slug-based
    // images.sorcerycard.io construction.
    return '';
  }

  // Summarize every printing of a card (standard, foil, promo, etc.) from
  // item.variants, so the card detail popup can list them all.
  function findPrintings(item) {
    const buckets = [item.variants, item.printings, item.editions, item.prints];
    for (const arr of buckets) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const out = arr.map(v => {
        if (!v) return null;
        const sc = v.setCard || v;
        const setName = sc.set?.name || sc.setName || '';
        const vSlug = sc.slug || v.slug || '';
        const finishRaw = v.finish || sc.finish || (vSlug.match(/-f$/) ? 'Foil' : (vSlug.match(/-s$/) ? 'Standard' : ''));
        const rarity = sc.rarity || '';
        const direct = v.src || v.image || v.imageUrl || v.art;
        const img = direct ? unwrapNextImage(direct) : '';
        const flavor = v.flavorText || '';
        if (!setName && !finishRaw && !rarity) return null;
        return { set: setName, finish: finishRaw, rarity, img, flavor };
      }).filter(Boolean);
      if (out.length) return out;
    }
    return [];
  }

  // Subtypes (e.g. Angel, Demon, Beast) aren't a separate structured field
  // -- confirmed from a live diagnostic dump that they only appear woven
  // into item.variants[].typeText, a flavor sentence combining the card's
  // rarity and subtype(s), e.g. "An Elite Demon of alluring demise" or
  // "Elite Spirits where Beasts once dwelled" (multiple subtypes, no fixed
  // separator). Rather than trying to exclude every possible non-subtype
  // word (rarity, articles, element names, type names, flavor text), this
  // matches against the fixed, known list of subtypes the person supplied
  // -- this is the same list used by the Subtype filter dropdown in
  // index.html (SUBTYPES), so the two must be kept in sync if the game
  // adds new subtypes later.
  const KNOWN_SUBTYPES = ['Angel', 'Beast', 'Demon', 'Dragon', 'Dwarf', 'Faerie', 'Giant', 'Gnome', 'Goblin', 'Merfolk', 'Monster', 'Mortal', 'Ogre', 'Spirit', 'Sphinx', 'Troll', 'Undead', 'Automaton', 'Device', 'Document', 'Instrument', 'Monument', 'Potion', 'Relic', 'Weapon', 'Desert', 'River', 'Tower', 'Village'];
  const SUBTYPE_LOOKUP = {};
  KNOWN_SUBTYPES.forEach(s => { SUBTYPE_LOOKUP[s.toLowerCase()] = s; });
  // Tries the word as typed, then common English plural endings, so
  // "Dwarves" matches "Dwarf", "Sphinxes" matches "Sphinx", "Demons"
  // matches "Demon", etc. -- any plural form should resolve to its
  // singular entry in KNOWN_SUBTYPES.
  function singularCandidates(w) {
    const out = [w];
    if (w.endsWith('ves')) out.push(w.slice(0, -3) + 'f');   // dwarves -> dwarf
    if (w.endsWith('ies')) out.push(w.slice(0, -3) + 'y');   // (e.g. -y nouns)
    if (w.endsWith('es'))  out.push(w.slice(0, -2));         // sphinxes -> sphinx
    if (w.endsWith('s'))   out.push(w.slice(0, -1));         // demons -> demon
    return out;
  }
  // Desert/River/Tower/Village don't appear in typeText like the other
  // subtypes -- confirmed by the person that for Site cards, the subtype
  // instead shows up as a capitalized word right in the card's own Name
  // (e.g. "Accursed Desert", "Accursed Tower"). Case-sensitive on purpose:
  // only a genuinely capitalized occurrence counts as the subtype, not an
  // incidental lowercase word.
  const SITE_SUBTYPES = new Set(['Desert', 'River', 'Tower', 'Village']);
  function findSiteSubtypesFromName(item) {
    const name = item.name || '';
    const found = [];
    name.split(/[^A-Za-z]+/).forEach(word => {
      if (SITE_SUBTYPES.has(word) && found.indexOf(word) < 0) found.push(word);
    });
    return found;
  }
  function findSubtypes(item) {
    let typeText = '';
    if (Array.isArray(item.variants)) {
      for (const v of item.variants) {
        if (v && v.typeText) { typeText = v.typeText; break; }
      }
    }
    const seen = new Set();
    const subs = [];
    if (typeText) {
      typeText.split(/[^A-Za-z]+/).forEach(raw => {
        if (!raw) return;
        const w = raw.toLowerCase();
        let canon;
        for (const cand of singularCandidates(w)) {
          if (SUBTYPE_LOOKUP[cand]) { canon = SUBTYPE_LOOKUP[cand]; break; }
        }
        if (canon && !seen.has(canon)) { seen.add(canon); subs.push(canon); }
      });
    }
    findSiteSubtypesFromName(item).forEach(s => {
      if (!seen.has(s)) { seen.add(s); subs.push(s); }
    });
    return subs;
  }

  // Prefer whatever curiosa marks as the card's current/errata'd text over
  // the original printed text, matching the "UPDATED: ..." convention
  // already used throughout index.html's built-in CARDS array.
  function findText(item) {
    const updated = item.updatedText || item.currentText || item.officialText || item.errataText || item.rulingText;
    const original = item.text || item.rulesText || item.ruleText || item.cardText || item.description || '';
    const isFlaggedUpdated = !!(item.isUpdated || item.updated || item.hasErrata || item.hasUpdate);
    if (updated && updated !== original) {
      return updated.indexOf('UPDATED:') === 0 ? updated : 'UPDATED: ' + updated;
    }
    if (isFlaggedUpdated && original && original.indexOf('UPDATED:') !== 0) {
      return 'UPDATED: ' + original;
    }
    return original;
  }

  // Element name/letter -> the single-letter code used in "th" tokens
  // (e.g. "2w" = two water threshold), matching index.html's cThr()/thrIcons().
  const ELETTER = { air: 'a', earth: 'e', fire: 'f', water: 'w', a: 'a', e: 'e', f: 'f', w: 'w' };

  function buildThToken(elName, count) {
    const letter = ELETTER[lower(elName)];
    const n = parseInt(count, 10) || 1;
    return letter ? `${n}${letter}` : '';
  }

  // Real shape confirmed from a live diagnostic dump: printing-specific data
  // (threshold, power, cost, rarity, rulesText) lives under item.setCard,
  // with one numeric field per element rather than a combined array/string.
  function findThreshold(item) {
    const sc = item.setCard || item;
    const map = [['airThreshold', 'a'], ['earthThreshold', 'e'], ['fireThreshold', 'f'], ['waterThreshold', 'w']];
    const tokens = [];
    map.forEach(([key, letter]) => {
      const n = Number(sc[key]);
      if (n > 0) tokens.push(`${n}${letter}`);
    });
    if (tokens.length) return tokens.join(' ');

    // Fall back to the more generic shapes in case a different card type
    // (e.g. avatar) doesn't use the four *Threshold fields.
    const candidates = [item.thresholds, item.threshold, item.thresholdText, item.affinity, item.affinities];
    for (const val of candidates) {
      if (val === undefined || val === null) continue;
      if (typeof val === 'string' && /^(\d+[aefw]\s*)+$/i.test(val.trim())) return val.trim();
      if (Array.isArray(val) && val.every(v => typeof v === 'string')) {
        const counts = {};
        val.forEach(v => {
          const m = v.match(/^(\d+)?\s*([aefw])$/i);
          if (m) { const l = m[2].toLowerCase(); counts[l] = (counts[l] || 0) + (parseInt(m[1], 10) || 1); return; }
          const letter = ELETTER[lower(v)];
          if (letter) counts[letter] = (counts[letter] || 0) + 1;
        });
        const toks = Object.keys(counts).map(l => `${counts[l]}${l}`);
        if (toks.length) return toks.join(' ');
      }
      if (Array.isArray(val) && val.every(v => v && typeof v === 'object')) {
        const toks = val.map(x => buildThToken(x.element || x.type || x.name, x.count || x.amount || 1)).filter(Boolean);
        if (toks.length) return toks.join(' ');
      }
      if (!Array.isArray(val) && typeof val === 'object') {
        const toks = Object.keys(val).map(k => buildThToken(k, val[k])).filter(Boolean);
        if (toks.length) return toks.join(' ');
      }
    }
    return '';
  }

  function findPower(item) {
    const sc = item.setCard || item;
    // Built-in CARDS data stores a split-power card's "attack" value as its
    // single pw (e.g. White Knight's printed 3/5 split power is pw:3).
    const candidates = [sc.attack, sc.defense, sc.power, sc.pow, sc.life];
    for (const v of candidates) {
      if (v !== undefined && v !== null && v !== '') {
        const n = Number(v);
        if (!Number.isNaN(n)) return n;
      }
    }
    return null;
  }

  // Real shape confirmed from live data: each printing's set info lives at
  // item.variants[].setCard.set.name, not a top-level item.set field. A card
  // can appear in multiple sets, so collect the unique set names across all
  // its variants rather than just the first one found.
  function findSets(item) {
    const names = [];
    const seen = new Set();
    if (Array.isArray(item.variants)) {
      item.variants.forEach(v => {
        const nm = v && v.setCard && v.setCard.set && v.setCard.set.name;
        if (nm && !seen.has(nm)) { seen.add(nm); names.push(nm); }
      });
    }
    if (!names.length) {
      const fallback = item.set?.name || item.setName || item.edition || item.editionName;
      if (fallback) names.push(fallback);
    }
    if (Array.isArray(item.sets)) {
      item.sets.forEach(s => {
        const nm = typeof s === 'string' ? s : (s && (s.name || s.setName));
        if (nm && !seen.has(nm)) { seen.add(nm); names.push(nm); }
      });
    }
    return names;
  }

  function norm(item) {
    if (!item?.name || !item?.slug) return null;

    const th = findThreshold(item);
    const powerVal = findPower(item);

    if (!th && powerVal === null) {
      console.warn('No threshold or power found for "' + (item.name || '?') + '". Raw item:');
      console.warn(JSON.stringify(item, null, 2));
    }

    // Element is derived primarily from the raw threshold counts (confirmed
    // reliable field names: airThreshold/earthThreshold/fireThreshold/
    // waterThreshold), picking whichever element has the highest count —
    // this is the actual game-accurate signal and works for both single-
    // and multi-threshold cards. item.elements (an array of {id,name}
    // objects) is only used as a fallback for genuinely elementless cards.
    const sc = item.setCard || item;
    const thCounts = {
      air:   Number(sc.airThreshold)   || 0,
      earth: Number(sc.earthThreshold) || 0,
      fire:  Number(sc.fireThreshold)  || 0,
      water: Number(sc.waterThreshold) || 0,
    };
    let el = 'neutral', bestCount = 0;
    Object.keys(thCounts).forEach(k => {
      if (thCounts[k] > bestCount) { bestCount = thCounts[k]; el = k; }
    });
    if (el === 'neutral') {
      const elemsArr = Array.isArray(item.elements) ? item.elements : null;
      const elemRaw = item.element || item.affinity || (elemsArr && elemsArr[0] && (elemsArr[0].id || elemsArr[0].name));
      el = EL_MAP[lower(elemRaw)] || 'neutral';
    }

    const t = TYPE_MAP[lower(item.type || item.category || item.cardType)] || 'minion';
    const r = RARITY_MAP[lower(item.rarity || item.rarityName)] || 'ordinary';
    const allSets = findSets(item);
    const setName = allSets[0] || '';
    const fullSlug = findFullSlug(item);
    const img = findImageUrl(item, fullSlug, t);

    const cost = item.cost ?? item.manaCost ?? item.mana_cost;

    const printings = findPrintings(item);
    const subtypes = findSubtypes(item);

    return {
      n:  item.name,
      el,
      t,
      c:  (cost === undefined || cost === null) ? null : Number(cost),
      pw: powerVal,
      r,
      s:  setName || (allSets[0] || ''),
      ss: allSets.length ? allSets : (setName ? [setName] : []),
      txt: findText(item),
      ar: item.artist || item.illustrator || item.artistName || '',
      th,
      sl: fullSlug,
      img: img || undefined,
      sub: subtypes.length ? subtypes : undefined,
      prints: printings.length ? printings : undefined,
    };
  }

  var _loggedSample = false;
  const rawByKey = new Map();

  // Fill gaps in `a` using `b`: keep whichever value is non-null/defined,
  // and for the threshold/power fields specifically, prefer a real non-zero
  // value over a zero/null one from a different occurrence of the same card.
  function mergeRaw(a, b) {
    const out = Object.assign({}, a);
    Object.keys(b).forEach(function(k) {
      if (out[k] === undefined || out[k] === null) out[k] = b[k];
    });
    ['waterThreshold', 'earthThreshold', 'fireThreshold', 'airThreshold'].forEach(function(k) {
      if ((!a[k]) && b[k]) out[k] = b[k];
    });
    ['attack', 'defense', 'life', 'power', 'pow'].forEach(function(k) {
      if ((a[k] === null || a[k] === undefined) && b[k] !== null && b[k] !== undefined) out[k] = b[k];
    });
    return out;
  }

  function absorb(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 14) return;
    if (Array.isArray(obj)) {
      if (obj.length && obj[0]?.slug && obj[0]?.name !== undefined) {
        if (!_loggedSample) {
          _loggedSample = true;
          console.log('Sample raw card object (for debugging slug/field mapping):');
          console.log(JSON.stringify(obj[0], null, 2));
        }
        obj.forEach(item => {
          if (!item || !item.name) return;
          const key = item.id || item.name;
          const existing = rawByKey.get(key);
          rawByKey.set(key, existing ? mergeRaw(existing, item) : item);
        });
      } else {
        obj.forEach(v => absorb(v, depth + 1));
      }
    } else {
      Object.values(obj).forEach(v => absorb(v, depth + 1));
    }
  }

  // ── Load page and scroll to trigger all lazy loads ────────────────────────
  console.log('Loading page...');
  await page.goto(CARDS_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  console.log(`After initial load: ${rawResponses.length} API response(s) intercepted`);

  let scrollRounds = 0;
  let lastCount    = 0;
  let staleRounds  = 0;

  while (scrollRounds < 300 && staleRounds < 6) {
    try {
      const btn = await page.$(
        'button:has-text("Load More"), button:has-text("Show More"), button:has-text("load more"), [data-testid="load-more"]'
      );
      if (btn && await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(1200);
        scrollRounds++;
        continue;
      }
    } catch (_) {}

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const el = document.querySelector('main, [role="main"], .card-list, .cards-container, #card-list');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(700);

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

  for (const resp of rawResponses) {
    absorb(resp, 0);
  }
  console.log(`Unique raw cards after merging duplicates: ${rawByKey.size}`);

  const cards = [];
  rawByKey.forEach(item => {
    const c = norm(item);
    if (c) cards.push(c);
  });
  console.log(`Cards after normalizing: ${cards.length}`);

  await browser.close();

  if (!cards.length) {
    console.error('No cards scraped.');
    process.exit(1);
  }

  // Card counts should only ever grow (new sets, new prints) -- a drop
  // almost always means the scrape was incomplete (site changes, a timeout
  // mid-scroll, a network hiccup) rather than cards genuinely disappearing
  // from the game. Refuse to overwrite a fuller cards.json with a smaller
  // one; the workflow step fails (and the commit step after it is skipped,
  // since GitHub Actions stops the job on a failed step), leaving the
  // existing file untouched.
  const existingPath = 'cards.json';
  let existingCount = 0;
  if (fs.existsSync(existingPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
      existingCount = Array.isArray(existing.cards) ? existing.cards.length : 0;
    } catch (e) {
      console.warn('Could not parse existing cards.json, proceeding without a comparison baseline:', e.message);
    }
  }
  if (existingCount > 0 && cards.length < existingCount) {
    console.error(
      `Refusing to overwrite cards.json: this scrape found ${cards.length} cards, fewer than the ${existingCount} ` +
      `already on file. Not writing -- investigate before re-running (site layout change, timeout, etc.).`
    );
    process.exit(1);
  }

  cards.sort((a, b) => a.n.localeCompare(b.n));

  fs.writeFileSync(
    'cards.json',
    JSON.stringify({ updated: new Date().toISOString(), total: cards.length, cards }, null, 2)
  );
  console.log('✓ Wrote cards.json');
})();
