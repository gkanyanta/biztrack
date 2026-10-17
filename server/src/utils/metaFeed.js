// The Meta (Facebook / WhatsApp) catalogue feed: one CSV row per sellable product, which Commerce
// Manager fetches on a schedule. (mirrored in api/index.js)
//
// Everything here only reads. A product that is missing something Meta requires is left out and
// reported with the reason, rather than padded with invented data — Meta rejects bad rows anyway,
// and an honest gap is easier to fix from the validation report than a made-up brand is to notice.

const crypto = require('crypto');

const META_FEED_COLUMNS = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand', 'product_type', 'item_group_id', 'sale_price'];

// Stores with their own shopper-facing domain. Mirrors STORE_DOMAINS in client/src/App.jsx; a store
// without one is served at /store/:slug on whichever host the feed was fetched from.
const STORE_ORIGINS = { 'privtech-solutions': 'https://store.privtech.net' };

function metaOrigins(slug, req) {
  if (STORE_ORIGINS[slug]) return { origin: STORE_ORIGINS[slug], storePath: '/' };
  return { origin: `https://${req.get('host')}`, storePath: `/store/${encodeURIComponent(slug)}` };
}

// Settings that switch the feed on and shape it. Opt-in per company, so no other tenant's catalogue
// starts appearing at a public URL because this shipped.
async function loadFeedSettings(prisma, companyId) {
  const rows = await prisma.setting.findMany({ where: { companyId, key: { in: ['metaFeedEnabled', 'metaFeedBrand', 'metaFeedSecret', 'currency'] } } });
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  return {
    enabled: s.metaFeedEnabled === 'true',
    fallbackBrand: (s.metaFeedBrand || '').trim(),
    secret: (s.metaFeedSecret || '').trim(),
    currency: /^[A-Z]{3}$/.test(s.currency || '') ? s.currency : 'ZMW',
  };
}

function feedTokenMatches(secret, token) {
  if (!secret) return true;
  const a = crypto.createHash('sha256').update(String(token || '')).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

const plain = (s, max) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const money = (n, currency) => `${Number(n).toFixed(2)} ${currency}`;

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A variant whose own name already carries its label ("T-Shirt Red") keeps it once.
function metaTitle(p) {
  const name = plain(p.name, 200);
  const label = plain(p.variantLabel, 100);
  if (!label || name.toLowerCase().includes(label.toLowerCase())) return name;
  return `${name} - ${label}`.slice(0, 200);
}

// Images are stored as base64 in the row and served by /store/product-image/:id. Meta only accepts
// JPEG or PNG, and only re-downloads an image whose URL changed, so the URL carries the product's
// updatedAt.
function metaImage(p, imageRef, origin) {
  if (!imageRef) return { error: 'no image' };
  const data = imageRef.match(/^data:image\/([\w.+-]+);base64,/i);
  if (data) {
    if (!/^(jpeg|jpg|png)$/i.test(data[1])) return { error: `image is ${data[1]}; Meta accepts JPEG or PNG` };
    return { url: `${origin}/api/v1/store/product-image/${p.id}?v=${new Date(p.updatedAt).getTime()}` };
  }
  if (/^https:\/\/\S+$/i.test(imageRef) && imageRef.length <= 2000) return { url: imageRef };
  return { error: 'image is not a public HTTPS URL' };
}

// Turns the company's active products into feed rows, plus the list of products left out and why.
// Only active products are read; Meta drops anything missing from a scheduled feed, so
// deactivating a product in BizTrack removes it from the catalogue on the next fetch.
async function buildMetaFeed(prisma, company, settings, { origin, storePath }) {
  const products = await prisma.product.findMany({
    where: { companyId: company.id, isActive: true },
    select: { id: true, name: true, sku: true, description: true, category: true, brand: true, sellingPrice: true, originalPrice: true, stock: true, groupId: true, variantLabel: true, updatedAt: true },
    orderBy: [{ groupId: 'asc' }, { name: 'asc' }],
  });
  // Only the first few characters of a base64 image are needed to know its type; pulling the whole
  // thing for every product would move megabytes to write a URL.
  const imageRows = products.length ? await prisma.$queryRaw`
    SELECT "id", CASE WHEN "imageUrl" LIKE 'data:%' THEN left("imageUrl", 40) ELSE "imageUrl" END AS "ref"
    FROM "Product" WHERE "companyId" = ${company.id} AND "isActive" = true AND "imageUrl" IS NOT NULL AND "imageUrl" <> ''` : [];
  const imageRef = new Map(imageRows.map(r => [r.id, r.ref]));

  const rows = [];
  const excluded = [];
  for (const p of products) {
    const errors = [];
    const title = metaTitle(p);
    if (!title) errors.push('no name');
    const description = plain(p.description, 9999);
    if (!description) errors.push('no description');
    const brand = plain(p.brand, 100) || plain(settings.fallbackBrand, 100);
    if (!brand) errors.push('no brand, and no fallback brand set');
    const selling = parseFloat(p.sellingPrice);
    if (!(selling > 0)) errors.push('selling price is not above zero');
    const image = metaImage(p, imageRef.get(p.id), origin);
    if (image.error) errors.push(image.error);
    if (errors.length) { excluded.push({ id: p.id, name: p.name, sku: p.sku, errors }); continue; }

    // A struck-through original price is the full price and the selling price is the sale, which is
    // how the store shows it. Meta requires sale_price to be below price.
    const original = p.originalPrice != null ? parseFloat(p.originalPrice) : null;
    const onSale = original != null && original > selling;
    rows.push({
      id: p.id,
      title,
      description,
      availability: p.stock > 0 ? 'in stock' : 'out of stock',
      condition: 'new',
      price: money(onSale ? original : selling, settings.currency),
      link: `${origin}${storePath}?product=${encodeURIComponent(p.id)}`,
      image_link: image.url,
      brand,
      product_type: plain(p.category, 750),
      item_group_id: p.groupId || '',
      sale_price: onSale ? money(selling, settings.currency) : '',
    });
  }
  const csv = [META_FEED_COLUMNS.join(','), ...rows.map(r => META_FEED_COLUMNS.map(c => csvField(r[c])).join(','))].join('\n') + '\n';
  return { rows, excluded, csv };
}

module.exports = { META_FEED_COLUMNS, metaOrigins, loadFeedSettings, feedTokenMatches, buildMetaFeed, csvField };
