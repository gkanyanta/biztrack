const router = require('express').Router();

// Public store routes - no auth required

// Get store info (company name, logo, settings)
router.get('/:slug/info', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company || !company.isActive) return res.status(404).json({ error: 'Store not found' });
    const settings = await prisma.setting.findMany({ where: { companyId: company.id } });
    const s = {};
    settings.forEach(st => { s[st.key] = st.value; });
    res.json({
      name: s.businessName || company.name,
      slug: company.slug,
      logo: s.companyLogo || null,
      phone: s.companyPhone || null,
      email: s.companyEmail || null,
      address: s.companyAddress || null,
      website: s.companyWebsite || null,
      currency: s.currencySymbol || s.currency || 'K',
      whatsapp: s.whatsappNumber || null,
      storeMessage: s.storeMessage || null,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Get active products for store
router.get('/:slug/products', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { slug: req.params.slug } });
    if (!company || !company.isActive) return res.status(404).json({ error: 'Store not found' });
    const { category, search } = req.query;
    const where = { companyId: company.id, isActive: true, stock: { gt: 0 } };
    if (category) where.category = category;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }
    const products = await prisma.product.findMany({
      where,
      select: { id: true, name: true, description: true, category: true, sellingPrice: true, imageUrl: true, stock: true },
      orderBy: { name: 'asc' },
    });
    // Get categories
    const allProducts = await prisma.product.findMany({
      where: { companyId: company.id, isActive: true, stock: { gt: 0 } },
      select: { category: true },
      distinct: ['category'],
    });
    const categories = allProducts.map(p => p.category).filter(Boolean).sort();
    res.json({ products, categories });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Place an order (public checkout)
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

    // Validate products
    const productIds = data.items.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId, isActive: true } });
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });

    for (const item of data.items) {
      const product = productMap[item.productId];
      if (!product) return res.status(400).json({ error: `Product not found` });
      if (product.stock < item.qty) return res.status(400).json({ error: `${product.name} only has ${product.stock} in stock` });
    }

    // Build sale items
    const saleItems = data.items.map(item => {
      const product = productMap[item.productId];
      const unitPrice = parseFloat(product.sellingPrice);
      const qty = parseInt(item.qty);
      return { productId: item.productId, qty, unitPrice, costPrice: parseFloat(product.costPrice), totalPrice: qty * unitPrice };
    });

    const itemsTotal = saleItems.reduce((sum, i) => sum + i.totalPrice, 0);

    // Shipping
    let shippingCost = 0;
    let shippingCharge = 0;
    if (data.customerCity) {
      const rate = await prisma.shippingRate.findFirst({ where: { city: { equals: data.customerCity, mode: 'insensitive' }, companyId } });
      if (rate) {
        shippingCost = parseFloat(rate.rate);
        shippingCharge = parseFloat(rate.rate);
      }
    }

    const totalPrice = itemsTotal + shippingCharge;

    // Order number
    const lastSale = await prisma.sale.findFirst({ where: { companyId }, orderBy: { createdAt: 'desc' } });
    let nextNum = 1;
    if (lastSale) { const match = lastSale.orderNumber.match(/ORD-(\d+)/); if (match) nextNum = parseInt(match[1]) + 1; }
    const orderNumber = `ORD-${String(nextNum).padStart(4, '0')}`;

    // Customer
    let customerId = null;
    if (data.customerPhone) {
      let customer = await prisma.customer.findFirst({ where: { phone: data.customerPhone, companyId } });
      if (!customer) {
        customer = await prisma.customer.create({ data: { name: data.customerName, phone: data.customerPhone, city: data.customerCity || null, source: 'Online Store', companyId } });
      }
      customerId = customer.id;
    }

    const sale = await prisma.sale.create({
      data: {
        orderNumber,
        totalPrice, shippingCost, shippingCharge,
        status: 'Pending', paymentStatus: 'Unpaid', paymentType: 'Cash',
        source: 'Online Store',
        customerId,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        customerCity: data.customerCity || null,
        deliveryAddress: data.deliveryAddress || null,
        notes: data.notes || null,
        companyId,
        items: { create: saleItems },
      },
    });

    await prisma.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: 'New', toStatus: 'Pending', companyId } });

    res.status(201).json({
      orderNumber: sale.orderNumber,
      total: totalPrice,
      shippingCharge,
      message: 'Order placed successfully! We will contact you shortly to confirm.',
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
