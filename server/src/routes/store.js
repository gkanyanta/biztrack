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
      paymentEnabled: !!(s.broadpayPublicKey),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
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
    const products = await prisma.product.findMany({ where, select: { id: true, name: true, description: true, category: true, sellingPrice: true, imageUrl: true, stock: true }, orderBy: { name: 'asc' } });
    const allProducts = await prisma.product.findMany({ where: { companyId: company.id, isActive: true, stock: { gt: 0 } }, select: { category: true }, distinct: ['category'] });
    const categories = allProducts.map(p => p.category).filter(Boolean).sort();
    res.json({ products, categories });
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

    if (publicKey && data.payOnline) {
      const baseUrl = req.headers.origin || req.headers.referer?.replace(/\/$/, '') || '';
      const nameParts = data.customerName.trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || firstName;

      const checkoutPayload = {
        merchantPublicKey: publicKey,
        transactionName: `Order ${orderNumber}`,
        amount: totalPrice,
        currency: 'ZMW',
        transactionReference: sale.id,
        customerFirstName: firstName,
        customerLastName: lastName,
        customerEmail: data.customerEmail || `${data.customerPhone}@store.local`,
        customerPhone: data.customerPhone,
        customerAddr: data.deliveryAddress || '',
        customerCity: data.customerCity || '',
        customerState: '',
        customerCountryCode: 'ZM',
        customerPostalCode: '',
        webhookUrl: `${baseUrl}/api/v1/store/webhook/broadpay`,
        returnUrl: `${baseUrl}/store/${req.params.slug}/payment-result?order=${sale.id}`,
        autoReturn: true,
        chargeMe: false,
      };

      try {
        const response = await fetch('https://checkout.broadpay.io/gateway/api/v1/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(checkoutPayload),
        });
        const result = await response.json();
        if (!result.isError && result.paymentUrl) {
          return res.status(201).json({
            orderNumber: sale.orderNumber,
            total: totalPrice,
            shippingCharge,
            paymentUrl: result.paymentUrl,
            paymentReference: result.reference,
            message: 'Redirecting to payment...',
          });
        }
      } catch (payErr) { console.error('BroadPay error:', payErr); }
    }

    // Fallback: no online payment
    res.status(201).json({
      orderNumber: sale.orderNumber,
      total: totalPrice,
      shippingCharge,
      message: 'Order placed successfully! We will contact you shortly to confirm.',
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// BroadPay webhook
router.post('/webhook/broadpay', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { reference, status, transactionReference } = req.body;
    const saleId = transactionReference || reference;
    if (!saleId) return res.status(400).json({ error: 'Missing reference' });

    const sale = await prisma.sale.findFirst({ where: { id: saleId } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    if (status === 'SUCCESSFUL' || status === 'successful' || status === 'SUCCESS') {
      await prisma.sale.update({
        where: { id: sale.id },
        data: { paymentStatus: 'Paid', paymentMethod: 'Online Payment', amountPaid: parseFloat(sale.totalPrice) }
      });
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
