const router = require('express').Router();

// Public store routes - no auth required

// Get store info
router.get('/:slug/info', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company || !company.isActive) return res.status(404).json({ error: 'Store not found' });
    const settings = await prisma.setting.findMany({ where: { companyId: company.id } });
    const s = {};
    settings.forEach(st => { s[st.key] = st.value; });
    const hasLogo = !!(s.companyLogo);
    res.json({
      name: s.businessName || company.name,
      slug: company.slug,
      logo: hasLogo ? `/api/v1/store/${req.params.slug}/logo` : null,
      phone: s.companyPhone || null,
      email: s.companyEmail || null,
      address: s.companyAddress || null,
      website: s.companyWebsite || null,
      currency: s.currencySymbol || s.currency || 'K',
      whatsapp: s.whatsappNumber || null,
      storeMessage: s.storeMessage || null,
      paymentEnabled: !!(s.lencoPublicKey || s.broadpayPublicKey),
      lencoPublicKey: s.lencoPublicKey || s.broadpayPublicKey || null,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Serve logo as cached image
router.get('/:slug/logo', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).end();
    const setting = await prisma.setting.findFirst({ where: { companyId: company.id, key: 'companyLogo' } });
    if (!setting?.value) return res.status(404).end();
    const match = setting.value.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(404).end();
    const buffer = Buffer.from(match[2], 'base64');
    res.set({ 'Content-Type': match[1], 'Cache-Control': 'public, max-age=86400', 'Content-Length': buffer.length });
    res.send(buffer);
  } catch { res.status(500).end(); }
});

// Serve product image as cached image
router.get('/product-image/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, select: { imageUrl: true } });
    if (!product?.imageUrl) return res.status(404).end();
    const match = product.imageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(404).end();
    const buffer = Buffer.from(match[2], 'base64');
    res.set({ 'Content-Type': match[1], 'Cache-Control': 'public, max-age=86400', 'Content-Length': buffer.length });
    res.send(buffer);
  } catch { res.status(500).end(); }
});

// Group storefront tiles into the sections the store renders as headed rows.
// Categories are keyed on a normalised label so a stray "fridges" or "Fridge " can't split a
// section in two — scripts/merge-product-categories.js fixes the stored spellings, this is the
// safety net for whatever gets typed next. A category holding a single product would be a
// heading with one tile under it, so those fall through into "More" at the end.
// (mirrored in api/index.js)
function buildStoreSections(tiles) {
  const norm = c => (c || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const byCat = new Map();
  const loose = [];
  for (const t of tiles) {
    const key = norm(t.category);
    if (!key) { loose.push(t); continue; }
    if (!byCat.has(key)) byCat.set(key, { labels: new Map(), tiles: [] });
    const entry = byCat.get(key);
    const label = t.category.trim();
    entry.labels.set(label, (entry.labels.get(label) || 0) + 1);
    entry.tiles.push(t);
  }
  const sections = [];
  for (const entry of byCat.values()) {
    if (entry.tiles.length < 2) { loose.push(...entry.tiles); continue; }
    const title = [...entry.labels.entries()].sort((a, b) => b[1] - a[1])[0][0];
    sections.push({ title, tiles: entry.tiles });
  }
  // Biggest categories first — that puts the ranges people actually shop for at the top and
  // keeps working as the catalogue changes, unlike a hand-maintained order.
  sections.sort((a, b) => b.tiles.length - a.tiles.length || a.title.localeCompare(b.title));
  if (loose.length) sections.push({ title: 'More', tiles: loose });
  return sections.map(s => ({
    title: s.title,
    // Cheapest first, so a range reads 43" -> 85" instead of jumbling model names.
    productIds: s.tiles.slice().sort((a, b) => parseFloat(a.sellingPrice) - parseFloat(b.sellingPrice)).map(t => t.id),
  }));
}

// Get active products
router.get('/:slug/products', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company || !company.isActive) return res.status(404).json({ error: 'Store not found' });
    const { category, search } = req.query;
    // No stock filter here — an out-of-stock color variant still needs to appear (as a disabled
    // swatch) if a sibling in its group is in stock. Zero-stock tiles are filtered out after grouping.
    const where = { companyId: company.id, isActive: true };
    if (category) where.category = category;
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }]; }
    const products = await prisma.product.findMany({ where, select: { id: true, name: true, description: true, category: true, sellingPrice: true, originalPrice: true, stock: true, groupId: true, variantLabel: true, group: { select: { id: true, name: true } } } });
    const withImages = await prisma.product.findMany({ where: { ...where, imageUrl: { not: null } }, select: { id: true } });
    const imageIds = new Set(withImages.map(p => p.id));

    // Sales velocity over the last 90 days, aggregated per product
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const velocityRows = products.length
      ? await prisma.saleItem.groupBy({
          by: ['productId'],
          where: { productId: { in: products.map(p => p.id) }, sale: { companyId: company.id, date: { gte: since }, status: { not: 'Cancelled' } } },
          _sum: { qty: true },
        })
      : [];
    const velocityMap = new Map(velocityRows.map(v => [v.productId, v._sum.qty || 0]));

    const enriched = products.map(p => {
      const onSale = p.originalPrice != null && parseFloat(p.originalPrice) > parseFloat(p.sellingPrice);
      return { ...p, imageUrl: imageIds.has(p.id) ? `/api/v1/store/product-image/${p.id}` : null, _onSale: onSale, _velocity: velocityMap.get(p.id) || 0 };
    });

    // Collapse products sharing a groupId into one tile with a `variants` array; ungrouped
    // products pass through as a single-variant tile with the same shape.
    const byGroup = new Map();
    const ungrouped = [];
    for (const p of enriched) {
      if (p.groupId) {
        if (!byGroup.has(p.groupId)) byGroup.set(p.groupId, []);
        byGroup.get(p.groupId).push(p);
      } else {
        ungrouped.push(p);
      }
    }
    const toVariant = v => ({ id: v.id, variantLabel: v.variantLabel, sellingPrice: v.sellingPrice, originalPrice: v.originalPrice, stock: v.stock, imageUrl: v.imageUrl });
    const groupedTiles = [...byGroup.entries()].map(([groupId, variants]) => {
      variants.sort((a, b) => (a.variantLabel || a.name).localeCompare(b.variantLabel || b.name));
      const primary = variants[0];
      return {
        id: primary.id, groupId, name: primary.group?.name || primary.name, description: primary.description, category: primary.category,
        sellingPrice: primary.sellingPrice, originalPrice: primary.originalPrice,
        stock: variants.reduce((sum, v) => sum + v.stock, 0), imageUrl: primary.imageUrl,
        variants: variants.map(toVariant),
        _onSale: variants.some(v => v._onSale), _velocity: variants.reduce((sum, v) => sum + v._velocity, 0),
      };
    });
    const ungroupedTiles = ungrouped.map(p => ({
      id: p.id, groupId: null, name: p.name, description: p.description, category: p.category,
      sellingPrice: p.sellingPrice, originalPrice: p.originalPrice, stock: p.stock, imageUrl: p.imageUrl,
      variants: [toVariant(p)], _onSale: p._onSale, _velocity: p._velocity,
    }));

    const inStock = [...ungroupedTiles, ...groupedTiles].filter(t => t.stock > 0);

    // Sections are the default view; a filtered or searched request is a flat result list, so
    // there is nothing to section and the client falls back to its plain grid.
    const sections = (category || search) ? [] : buildStoreSections(inStock);
    const popularIds = inStock
      .filter(t => t._velocity > 0)
      .sort((a, b) => b._velocity - a._velocity)
      .slice(0, 8)
      .map(t => t.id);

    const productsWithUrls = inStock
      .sort((a, b) => {
        if (a._onSale !== b._onSale) return a._onSale ? -1 : 1;
        if (a._velocity !== b._velocity) return b._velocity - a._velocity;
        return a.name.localeCompare(b.name);
      })
      .map(({ _onSale, _velocity, ...rest }) => rest);
    // Pills come from the sections themselves so a pill can never point at a heading that
    // isn't on the page.
    const categories = sections.filter(s => s.title !== 'More').map(s => s.title);
    res.json({ products: productsWithUrls, categories, sections, popularIds });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Place order
router.post('/:slug/order', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company || !company.isActive) return res.status(404).json({ error: 'Store not found' });
    const companyId = company.id;
    const data = req.body;

    if (!data.items || !data.items.length) return res.status(400).json({ error: 'Cart is empty' });
    if (!data.customerName) return res.status(400).json({ error: 'Name is required' });
    if (!data.customerPhone) return res.status(400).json({ error: 'Phone number is required' });

    const productIds = data.items.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId, isActive: true } });
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });
    for (const item of data.items) {
      const product = productMap[item.productId];
      if (!product) return res.status(400).json({ error: 'Product not found' });
      if (product.stock < item.qty) return res.status(400).json({ error: `${product.name} only has ${product.stock} in stock` });
    }

    const saleItems = data.items.map(item => {
      const product = productMap[item.productId];
      const unitPrice = parseFloat(product.sellingPrice);
      const qty = parseInt(item.qty);
      return { productId: item.productId, qty, unitPrice, costPrice: parseFloat(product.costPrice), totalPrice: qty * unitPrice };
    });
    const itemsTotal = saleItems.reduce((sum, i) => sum + i.totalPrice, 0);

    let shippingCost = 0, shippingCharge = 0;
    if (data.customerCity) {
      const rate = await prisma.shippingRate.findFirst({ where: { city: { equals: data.customerCity, mode: 'insensitive' }, companyId } });
      if (rate) { shippingCost = parseFloat(rate.rate); shippingCharge = parseFloat(rate.rate); }
    }
    const totalPrice = itemsTotal + shippingCharge;

    const lastSale = await prisma.sale.findFirst({ where: { companyId }, orderBy: { createdAt: 'desc' } });
    let nextNum = 1;
    if (lastSale) { const match = lastSale.orderNumber.match(/ORD-(\d+)/); if (match) nextNum = parseInt(match[1]) + 1; }
    const orderNumber = `ORD-${String(nextNum).padStart(4, '0')}`;

    let customerId = null;
    if (data.customerPhone) {
      let customer = await prisma.customer.findFirst({ where: { phone: data.customerPhone, companyId } });
      if (!customer) customer = await prisma.customer.create({ data: { name: data.customerName, phone: data.customerPhone, city: data.customerCity || null, source: 'Online Store', companyId } });
      customerId = customer.id;
    }

    const sale = await prisma.sale.create({
      data: { orderNumber, totalPrice, shippingCost, shippingCharge, status: 'Pending', paymentStatus: 'Unpaid', paymentType: 'Cash', source: 'Online Store', customerId, customerName: data.customerName, customerPhone: data.customerPhone, customerCity: data.customerCity || null, deliveryAddress: data.deliveryAddress || null, notes: data.notes || null, companyId, items: { create: saleItems } },
    });
    await prisma.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: 'New', toStatus: 'Pending', companyId } });

    // Check if BroadPay is configured for online payment
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });
    const publicKey = settingsMap.broadpayPublicKey;

    res.status(201).json({ orderNumber: sale.orderNumber, saleId: sale.id, total: totalPrice, shippingCharge, message: 'Order placed successfully!' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Verify Lenco payment.
// Only marks Paid when Lenco's API confirms `status === 'successful'`.
// On any other outcome (no secret key, network error, non-success), leaves the
// sale alone and returns verified:false — webhook will reconcile if it fires.
router.post('/:slug/verify-payment', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ error: 'Store not found' });
    const { reference, saleId } = req.body;
    if (!reference || !saleId) return res.status(400).json({ error: 'Missing reference or saleId' });
    const sale = await prisma.sale.findFirst({ where: { id: saleId, companyId: company.id } });
    if (!sale) return res.status(404).json({ error: 'Order not found' });
    const settings = await prisma.setting.findMany({ where: { companyId: company.id } });
    const settingsMap = {}; settings.forEach(s => { settingsMap[s.key] = s.value; });
    const secretKey = settingsMap.lencoSecretKey;
    if (!secretKey) {
      console.warn('verify-payment: lencoSecretKey not configured; leaving sale as Pending');
      return res.json({ verified: false, paymentStatus: sale.paymentStatus, reason: 'no-secret-key' });
    }
    try {
      const verifyRes = await fetch(`https://api.lenco.co/access/v2/collections/status/${reference}`, {
        headers: { 'Authorization': `Bearer ${secretKey}`, 'Content-Type': 'application/json' }
      });
      const verifyData = await verifyRes.json();
      if (verifyData.status === true && verifyData.data?.status === 'successful') {
        await prisma.sale.update({ where: { id: sale.id }, data: { paymentStatus: 'Paid', paymentMethod: 'Lenco Online', amountPaid: parseFloat(sale.totalPrice) } });
        return res.json({ verified: true, paymentStatus: 'Paid' });
      }
      return res.json({ verified: false, paymentStatus: sale.paymentStatus, lencoStatus: verifyData.data?.status || 'unknown' });
    } catch (verifyErr) {
      console.error('Lenco verify error:', verifyErr.message);
      return res.json({ verified: false, paymentStatus: sale.paymentStatus, reason: 'verify-error' });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Lenco webhook
router.post('/webhook/lenco', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { event, data } = req.body;
    if (event === 'transaction.successful') {
      const reference = data?.reference;
      if (reference) {
        const sale = await prisma.sale.findFirst({ where: { id: reference } });
        if (sale && sale.paymentStatus !== 'Paid') {
          await prisma.sale.update({ where: { id: sale.id }, data: { paymentStatus: 'Paid', paymentMethod: 'Lenco Online', amountPaid: parseFloat(sale.totalPrice) } });
        }
      }
    }
    res.json({ status: 'ok' });
  } catch (err) { console.error('Webhook error:', err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Check payment status
router.get('/:slug/payment-status/:saleId', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company) return res.status(404).json({ error: 'Store not found' });
    const sale = await prisma.sale.findFirst({
      where: { id: req.params.saleId, companyId: company.id },
      select: { orderNumber: true, totalPrice: true, paymentStatus: true, shippingCharge: true }
    });
    if (!sale) return res.status(404).json({ error: 'Order not found' });
    res.json(sale);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
