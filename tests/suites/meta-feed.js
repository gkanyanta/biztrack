// The Meta catalogue feed: what Facebook and WhatsApp are told about a store's products.
const { loginAs, client } = require('../lib/harness');

// RFC 4180, enough to read back exactly what the feed wrote.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return { header, items: body.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
}

module.exports = {
  name: 'Meta catalogue feed',
  seed: 'metafeed',
  async run({ base, prisma, seed, t }) {
    const { eq, section } = t;
    const { ids } = seed;
    const get = (path) => fetch(base + path);

    const res = await get('/store/shop-a/meta-feed.csv');
    const text = await res.text();
    const { header, items } = parseCsv(text);
    const byId = Object.fromEntries(items.map(i => [i.id, i]));

    section('a valid export');
    eq('the feed answers 200 as UTF-8 CSV', [res.status, res.headers.get('content-type')], [200, 'text/csv; charset=utf-8']);
    eq('the header carries the Meta field names in order', header,
      ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand', 'product_type', 'item_group_id', 'sale_price']);
    eq('the CDN may cache it briefly so an hourly fetch stays cheap', res.headers.get('cache-control'), 'public, max-age=0, s-maxage=900, stale-while-revalidate=300');
    eq('every publishable product is a row, keyed by its stable id',
      items.map(i => i.id).sort(), [ids.plain, ids.fallback, ids.onSale, ids.notASale, ids.soldOut, ids.tricky, ids.red, ids.blue].sort());
    const p = byId[ids.plain];
    eq('a plain product maps field for field', [p.title, p.description, p.availability, p.condition, p.brand, p.product_type, p.item_group_id, p.sale_price],
      ['Massage Gun Pro', 'Deep tissue massage gun.', 'in stock', 'new', 'Acme', 'Massage Guns', '', '']);
    eq('the product link opens that product on the storefront', p.link, `https://localhost:5099/store/shop-a?product=${ids.plain}`.replace('5099', new URL(base).port));
    eq('a product with no brand of its own takes the store fallback', byId[ids.fallback].brand, 'Shop A');

    section('ZMW pricing');
    eq('price is two decimals and the ISO code, no symbol', p.price, '1500.00 ZMW');
    eq('fractional kwacha keep their ngwee', byId[ids.fallback].price, '650.50 ZMW');
    eq('a struck-through original is the price and the selling price is the sale', [byId[ids.onSale].price, byId[ids.onSale].sale_price], ['2000.00 ZMW', '1500.00 ZMW']);
    eq('an "original" below the selling price is not a sale', [byId[ids.notASale].price, byId[ids.notASale].sale_price], ['900.00 ZMW', '']);

    section('variants');
    eq('variants share the group id as item_group_id', [byId[ids.red].item_group_id, byId[ids.blue].item_group_id], [seed.groupId, seed.groupId]);
    eq('a variant title carries its label, once', [byId[ids.red].title, byId[ids.blue].title], ['T-Shirt - Red', 'T-Shirt Blue']);
    eq('each variant reports its own stock', [byId[ids.red].availability, byId[ids.blue].availability], ['in stock', 'out of stock']);

    section('stock and status');
    eq('an out-of-stock product stays listed as out of stock', byId[ids.soldOut]?.availability, 'out of stock');
    eq('an inactive product is not in the feed', byId[ids.inactive], undefined);

    section('images');
    eq('the image is the public product-image endpoint, versioned so Meta notices a change',
      /^https:\/\/localhost:\d+\/api\/v1\/store\/product-image\/[\w-]+\?v=\d+$/.test(p.image_link), true);
    eq('no base64 image data appears anywhere in the feed', /base64|data:image/.test(text), false);
    const img = await fetch(base.replace(/\/api\/v1$/, '') + new URL(p.image_link).pathname + new URL(p.image_link).search);
    eq('Meta can fetch the image with no credentials', [img.status, img.headers.get('content-type')], [200, 'image/png']);
    eq('a product with no image is left out', byId[ids.noImage], undefined);
    eq('a WebP image is left out, since Meta takes JPEG or PNG', byId[ids.webp], undefined);

    section('incomplete products');
    eq('a product with no description is left out rather than given one', byId[ids.noDescription], undefined);
    eq('a free product is left out', byId[ids.free], undefined);

    section('CSV escaping');
    const tv = byId[ids.tricky];
    eq('a quote and a comma in the title survive the round trip', tv.title, 'TV 55", Smart');
    eq('the description is flattened to one line of plain text', tv.description, 'Says "wow", then stops .');
    eq('a comma in the category survives', tv.product_type, 'TVs, Large');
    eq('every line has exactly one field per column', items.every(i => Object.values(i).every(v => v !== undefined)), true);

    section('nothing private');
    eq('cost prices are never published', text.includes('777.77'), false);
    eq('suppliers are never published', text.includes('Secret Supplier'), false);

    section('one company per feed');
    eq("another company's products never appear", text.includes('Rival Widget') || items.some(i => i.id === ids.rival), false);
    const rivalText = await (await get('/store/privtech-solutions/meta-feed.csv')).text();
    const rival = parseCsv(rivalText).items;
    eq('and that company sees only its own', rival.map(i => i.id), [ids.rival]);
    eq('a store with its own domain links there', rival[0].link, `https://store.privtech.net/?product=${ids.rival}`);
    eq('…and serves its images from there too', rival[0].image_link.startsWith('https://store.privtech.net/api/v1/store/product-image/'), true);

    section('refusing');
    eq('an unknown store is not found', (await get('/store/no-such-store/meta-feed.csv')).status, 404);
    eq('a deactivated company is not found', (await get('/store/closed/meta-feed.csv')).status, 404);
    eq('a store that has not switched the feed on is not found', (await get('/store/feed-off/meta-feed.csv')).status, 404);
    eq('a token-protected feed is not found without its token', (await get('/store/locked/meta-feed.csv')).status, 404);
    eq('…or with the wrong one', (await get('/store/locked/meta-feed.csv?token=guess')).status, 404);
    eq('…and answers with the right one', (await get('/store/locked/meta-feed.csv?token=let-meta-in')).status, 200);

    section('empty catalogue');
    const emptyRes = await get('/store/nothing-ready/meta-feed.csv');
    eq('a store with nothing publishable gets a 503, never an empty 200 that would wipe the catalogue',
      [emptyRes.status, emptyRes.headers.get('cache-control'), emptyRes.headers.get('retry-after')], [503, 'no-store', '3600']);

    section('database errors');
    // A real failure, not a mock: the table the feed reads disappears for the length of one fetch.
    await prisma.$executeRawUnsafe('ALTER TABLE "Product" RENAME TO "Product_hidden"');
    let broken;
    try { broken = await get('/store/shop-a/meta-feed.csv'); }
    finally { await prisma.$executeRawUnsafe('ALTER TABLE "Product_hidden" RENAME TO "Product"'); }
    const brokenBody = await broken.text();
    eq('a database failure is a 503 that is never cached', [broken.status, broken.headers.get('cache-control')], [503, 'no-store']);
    eq('…and publishes no CSV at all', brokenBody.includes('id,title'), false);
    eq('the feed recovers once the database does', (await get('/store/shop-a/meta-feed.csv')).status, 200);

    section('the validation report');
    const admin = await loginAs(base, 'boss');
    const report = await admin('GET', '/products/meta-feed');
    eq('an admin can see what the feed publishes', [report.status, report.body.enabled, report.body.included, report.body.outOfStock], [200, true, 8, 2]);
    const reasons = Object.fromEntries(report.body.excluded.map(e => [e.id, e.errors]).sort());
    eq('every product left out is listed with why', reasons, Object.fromEntries(Object.entries({
      [ids.noImage]: ['no image'],
      [ids.webp]: ['image is webp; Meta accepts JPEG or PNG'],
      [ids.noDescription]: ['no description'],
      [ids.free]: ['selling price is not above zero'],
    }).sort()));
    eq('inactive products are not reported as problems', ids.inactive in reasons, false);
    eq('the report gives the URL to paste into Commerce Manager', report.body.feedUrl.endsWith('/api/v1/store/shop-a/meta-feed.csv'), true);
    const storesRole = await loginAs(base, 'stores');
    eq('the report is closed to non-admins', (await storesRole('GET', '/products/meta-feed')).status, 403);
    eq('and to anyone signed out', (await client(base)('GET', '/products/meta-feed')).status, 401);

    section('brand on the product');
    const created = await admin('POST', '/products', { name: 'Branded Thing', sku: 'BR-1', description: 'Has a brand.', costPrice: 1, sellingPrice: 10, stock: 1, brand: '  Hisense  ' });
    eq('a product saves its brand, trimmed', [created.status, created.body.brand], [201, 'Hisense']);
    const cleared = await admin('PUT', `/products/${created.body.id}`, { name: 'Branded Thing', brand: '' });
    eq('clearing the brand stores nothing rather than an empty string', cleared.body.brand, null);
  },
};
