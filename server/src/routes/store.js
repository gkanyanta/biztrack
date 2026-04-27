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

// Get active products
router.get('/:slug/products', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company || !company.isActive) return res.status(404).json({ error: 'Store not found' });
    const { category, search } = req.query;
    const where = { companyId: company.id, isActive: true, stock: { gt: 0 } };
    if (category) where.category = category;
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }]; }
    const products = await prisma.product.findMany({ where, select: { id: true, name: true, description: true, category: true, sellingPrice: true, originalPrice: true, stock: true } });
    const withImages = await prisma.product.findMany({ where: { ...where, imageUrl: { not: null } }, select: { id: true } });
    const imageIds = new Set(withImages.map(p => p.id));

    // Sales velocity over the last 90 days, aggregated per product
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const velocityRows = products.length
      ? await prisma.saleItem.groupBy({
          by: ['productId'],
          where: { productId: { in: products.map(p => p.id) }, sale: { companyId: company.id, date: { gte: since } } },
          _sum: { qty: true },
        })
      : [];
    const velocityMap = new Map(velocityRows.map(v => [v.productId, v._sum.qty || 0]));

    const productsWithUrls = products
      .map(p => {
        const onSale = p.originalPrice != null && parseFloat(p.originalPrice) > parseFloat(p.sellingPrice);
        return { ...p, imageUrl: imageIds.has(p.id) ? `/api/v1/store/product-image/${p.id}` : null, _onSale: onSale, _velocity: velocityMap.get(p.id) || 0 };
      })
      .sort((a, b) => {
        if (a._onSale !== b._onSale) return a._onSale ? -1 : 1;
        if (a._velocity !== b._velocity) return b._velocity - a._velocity;
        return a.name.localeCompare(b.name);
      })
      .map(({ _onSale, _velocity, ...rest }) => rest);
    const allProducts = await prisma.product.findMany({ where: { companyId: company.id, isActive: true, stock: { gt: 0 } }, select: { category: true }, distinct: ['category'] });
    const categories = allProducts.map(p => p.category).filter(Boolean).sort();
    res.json({ products: productsWithUrls, categories });
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
