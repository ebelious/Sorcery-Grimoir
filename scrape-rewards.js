// Dust rewards catalogue, from Team Covenant's store -- the publisher moved Dust
// redemption there (https://www.teamcovenant.com/games/sorcery-tcg?category=Dust).
//
// No browser needed. Confirmed from a HAR of that page: the storefront is a
// Next.js shell with no products in its HTML, and the page fills itself from ONE
// unauthenticated JSON call, which is what this reads:
//
//   GET https://www.teamcovenant.com/api/games-page?slug=sorcery-tcg
//   -> { allProductImages, pageComponents:[...], pageCategories:[{id,display_name,...}] }
//
// Each pageComponent carries `page_category` (a category id) and, for a product
// tile, `product_basic_component_id.product`. The Dust tab is the category whose
// display_name is "Dust" -- resolved by NAME here rather than hard-coding its id
// (112 at the time of writing), so a renumbering on their side does not empty the
// feed. Everything below mirrors the site's own page JS (also in the HAR):
//   * a Dust price is `product.dust_price` when it is a finite number > 0
//   * "Out of stock" is shown when !(hasAvailableInventory && is_available)
//   * images are served through Supabase's image renderer:
//       https://okxleekxriptfrdarxdq.supabase.co/storage/v1/render/image/public/<storage_location>?width=..&quality=..&resize=contain
//
// Output: rewards.json, the same shape the app already reads
//   { updated, total, rewards:[ { name, points, image, url, soldOut, slug, sku, limit } ] }
// `name`, `points`, `image`, `url`, `soldOut` are what index.html uses; the rest is
// carried along because it costs nothing and is there. Newest first, so the app's
// new-reward check (which looks at the first entry's name) fires on a genuinely
// new item rather than on a re-sort.
//
// Product pages: the HAR shows no per-product URL for these tiles (they render
// inline on the category page), so `url` is the category page for every entry.
// If Team Covenant adds product pages, set PRODUCT_URL below.
//
// Node 18+ (global fetch). No dependencies.

const fs = require('fs');

const API_URL      = 'https://www.teamcovenant.com/api/games-page?slug=sorcery-tcg';
const CATEGORY     = 'Dust';
const PAGE_URL     = 'https://www.teamcovenant.com/games/sorcery-tcg?category=Dust';
const IMG_BASE     = 'https://okxleekxriptfrdarxdq.supabase.co/storage/v1/render/image/public/';
const IMG_WIDTH    = 600;     // the app shows these in ~130px tiles; 600 covers 3x screens
const OUT_FILE     = 'rewards.json';
const PRODUCT_URL  = null;    // e.g. (p) => 'https://www.teamcovenant.com/products/' + p.slug -- unknown, see note above

function imageUrl(img) {
  const loc = img && img.storage_location;
  if (!loc) return '';
  return IMG_BASE + loc + '?width=' + IMG_WIDTH + '&quality=100&resize=contain';
}

function dustPrice(p) {
  const n = Number(p && p.dust_price);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function main() {
  const res = await fetch(API_URL, {
    headers: {
      'Accept': 'application/json',
      'Referer': PAGE_URL,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error('games-page HTTP ' + res.status);
  const data = await res.json();

  const cats = Array.isArray(data.pageCategories) ? data.pageCategories : [];
  const dustCat = cats.find(c => c && String(c.display_name || '').trim().toLowerCase() === CATEGORY.toLowerCase());
  if (!dustCat) {
    console.error('No "' + CATEGORY + '" category in pageCategories. Categories seen: ' +
      cats.map(c => c && c.display_name).join(', '));
    process.exit(1);
  }

  const comps = Array.isArray(data.pageComponents) ? data.pageComponents : [];
  const rewards = [];
  const seen = new Set();
  for (const pc of comps) {
    if (!pc || pc.page_category !== dustCat.id) continue;
    const pb = pc.product_basic_component_id;
    const p = pb && pb.product;
    if (!p) continue;
    if (pb.is_visible === false) continue;                 // hidden tile
    if (p.is_archived || (p.status && p.status !== 'published')) continue;
    const points = dustPrice(p);
    if (points === null) continue;                         // not a Dust item
    const key = p.sku || p.slug || p.id;
    if (seen.has(key)) continue;
    seen.add(key);
    rewards.push({
      name: String(p.name || p.internal_display_name || '').trim(),
      points: points,
      image: imageUrl(p.main_image),
      url: PRODUCT_URL ? PRODUCT_URL(p) : PAGE_URL,
      soldOut: !(p.hasAvailableInventory && p.is_available),
      slug: p.slug || '',
      sku: p.sku || '',
      limit: (typeof p.limit_per_customer === 'number') ? p.limit_per_customer : null,
      created: p.created_at || ''
    });
  }

  // newest first; ties keep the page's own order
  rewards.sort((a, b) => (b.created || '').localeCompare(a.created || ''));

  if (!rewards.length) {
    console.error('No Dust rewards found -- not writing ' + OUT_FILE + '.');
    process.exit(1);
  }

  // Same guard as scrape-cards.js: a much smaller result is far more likely a
  // partial/changed response than a real catalogue shrink. Refuse to overwrite
  // a fuller file with one under half its size.
  let existingCount = 0;
  if (fs.existsSync(OUT_FILE)) {
    try { existingCount = (JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).rewards || []).length; } catch (e) {}
  }
  if (existingCount > 0 && rewards.length < existingCount / 2) {
    console.error('Refusing to overwrite ' + OUT_FILE + ': found ' + rewards.length + ' rewards, previous file had ' + existingCount + '.');
    process.exit(1);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ updated: new Date().toISOString(), total: rewards.length, rewards }, null, 2));
  const soldOut = rewards.filter(r => r.soldOut).length;
  console.log('Wrote ' + OUT_FILE + ': ' + rewards.length + ' Dust rewards (' + soldOut + ' out of stock).');
}

main().catch(e => { console.error(e); process.exit(1); });
