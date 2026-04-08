const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { validateSale } = require('../middleware/validate');

router.use(authenticate);

const saleInclude = { items: { include: { product: true } }, customer: true };

// ---- CREDIT SUMMARY (must be before /:id routes) ----
router.get('/credit/summary', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const creditSales = await prisma.sale.findMany({ where: { companyId, paymentType: 'Credit', paymentStatus: { not: 'Paid' } }, include: { customer: true } });
    const now = new Date();
    let totalOutstanding = 0, overdueCount = 0, overdueAmount = 0;
    const debtorMap = {};
    creditSales.forEach(s => {
      const balance = parseFloat(s.totalPrice) - parseFloat(s.amountPaid);
      totalOutstanding += balance;
      const isOverdue = s.creditDueDate && new Date(s.creditDueDate) < now;
      if (isOverdue) { overdueCount++; overdueAmount += balance; }
      const key = s.customerId || s.customerName || 'Unknown';
      if (!debtorMap[key]) debtorMap[key] = { customerId: s.customerId, customerName: s.customerName || s.customer?.name || 'Unknown', customerPhone: s.customerPhone || s.customer?.phone, whatsapp: s.customer?.whatsapp, totalOwed: 0, salesCount: 0, oldestDueDate: null };
      debtorMap[key].totalOwed += balance;
      debtorMap[key].salesCount++;
      if (s.creditDueDate && (!debtorMap[key].oldestDueDate || new Date(s.creditDueDate) < new Date(debtorMap[key].oldestDueDate))) debtorMap[key].oldestDueDate = s.creditDueDate;
    });
    const topDebtors = Object.values(debtorMap).sort((a, b) => b.totalOwed - a.totalOwed);
    const recentPayments = await prisma.creditPayment.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 10, include: { sale: { select: { orderNumber: true, customerName: true } } } });
    res.json({ totalOutstanding, overdueCount, overdueAmount, topDebtors, recentPayments });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { status, paymentStatus, paymentType, from, to, customerId, search, creditOverdue } = req.query;
    const where = { companyId };
    if (status) where.status = status;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (paymentType) where.paymentType = paymentType;
    if (customerId) where.customerId = customerId;
    if (creditOverdue === 'true') { where.paymentType = 'Credit'; where.paymentStatus = { not: 'Paid' }; where.creditDueDate = { lt: new Date() }; }
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    if (search) { where.OR = [{ orderNumber: { contains: search, mode: 'insensitive' } }, { customerName: { contains: search, mode: 'insensitive' } }, { customerPhone: { contains: search, mode: 'insensitive' } }]; }
    const sales = await prisma.sale.findMany({ where, include: saleInclude, orderBy: { createdAt: 'desc' } });
    res.json(sales);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId }, include: { ...saleInclude, statusHistory: { orderBy: { createdAt: 'desc' } }, creditPayments: { orderBy: { createdAt: 'desc' } }, debtReminders: { orderBy: { sentAt: 'desc' } } } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    res.json(sale);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/', validateSale, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const data = req.body;
    const items = data.items;

    // Validate products
    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId } });
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });
    for (const item of items) {
      if (!productMap[item.productId]) return res.status(400).json({ error: `Product not found: ${item.productId}` });
    }

    // Order number
    const lastSale = await prisma.sale.findFirst({ where: { companyId }, orderBy: { createdAt: 'desc' } });
    let nextNum = 1;
    if (lastSale) { const match = lastSale.orderNumber.match(/ORD-(\d+)/); if (match) nextNum = parseInt(match[1]) + 1; }
    const orderNumber = `ORD-${String(nextNum).padStart(4, '0')}`;

    // Customer
    let customerId = data.customerId;
    if (!customerId && data.customerName) {
      let customer = null;
      if (data.customerPhone) customer = await prisma.customer.findFirst({ where: { phone: data.customerPhone, companyId } });
      if (!customer) customer = await prisma.customer.create({ data: { name: data.customerName, phone: data.customerPhone || null, city: data.customerCity || null, source: data.source || null, companyId } });
      customerId = customer.id;
    }

    // Shipping
    let shippingCost = parseFloat(data.shippingCost) || 0;
    if (data.customerCity && !data.shippingCost) {
      const rate = await prisma.shippingRate.findFirst({ where: { city: data.customerCity, companyId } });
      if (rate) shippingCost = parseFloat(rate.rate);
    }

    // Calculate items totals
    const saleItems = items.map(item => {
      const product = productMap[item.productId];
      const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
      const qty = parseInt(item.qty);
      return { productId: item.productId, qty, unitPrice, costPrice: parseFloat(product.costPrice), totalPrice: qty * unitPrice };
    });
    const itemsTotal = saleItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const discount = parseFloat(data.discount) || 0;
    const shippingCharge = parseFloat(data.shippingCharge) || 0;
    const totalPrice = itemsTotal + shippingCharge - discount;

    // Payment
    const paymentType = data.paymentType || 'Cash';
    let amountPaid = parseFloat(data.amountPaid) || 0;
    if (paymentType === 'Cash' && (data.paymentStatus === 'Paid' || !data.paymentStatus)) amountPaid = totalPrice;
    let paymentStatus = data.paymentStatus || 'Unpaid';
    if (paymentType === 'Credit') {
      if (amountPaid >= totalPrice) paymentStatus = 'Paid';
      else if (amountPaid > 0) paymentStatus = 'Partial';
      else paymentStatus = 'Unpaid';
    }

    const sale = await prisma.sale.create({
      data: {
        orderNumber, date: data.date ? new Date(data.date) : new Date(),
        totalPrice, shippingCost, shippingCharge, discount,
        status: data.status || 'Pending', paymentStatus, paymentMethod: data.paymentMethod || null, source: data.source || null,
        paymentType, amountPaid, creditDueDate: data.creditDueDate ? new Date(data.creditDueDate) : null, creditNotes: data.creditNotes || null,
        customerId, customerName: data.customerName || null, customerPhone: data.customerPhone || null, customerCity: data.customerCity || null,
        deliveryAddress: data.deliveryAddress || null, notes: data.notes || null, companyId,
        items: { create: saleItems },
      },
      include: saleInclude,
    });

    // Stock deduction
    if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
      for (const item of sale.items) {
        await prisma.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.qty } } });
        await prisma.stockLog.create({ data: { productId: item.productId, change: -item.qty, reason: 'Sale', saleId: sale.id, companyId } });
      }
    }

    await prisma.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: 'New', toStatus: sale.status, companyId } });
    res.status(201).json(sale);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const raw = req.body;
    const existing = await prisma.sale.findFirst({ where: { id: req.params.id, companyId }, include: { items: true } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const data = {
      ...(raw.shippingCost !== undefined && { shippingCost: parseFloat(raw.shippingCost) || 0 }),
      ...(raw.shippingCharge !== undefined && { shippingCharge: parseFloat(raw.shippingCharge) || 0 }),
      ...(raw.discount !== undefined && { discount: parseFloat(raw.discount) || 0 }),
      ...(raw.date && { date: new Date(raw.date) }),
      ...(raw.paymentMethod !== undefined && { paymentMethod: raw.paymentMethod || null }),
      ...(raw.paymentStatus && { paymentStatus: raw.paymentStatus }),
      ...(raw.source !== undefined && { source: raw.source || null }),
      ...(raw.customerName !== undefined && { customerName: raw.customerName || null }),
      ...(raw.customerPhone !== undefined && { customerPhone: raw.customerPhone || null }),
      ...(raw.customerCity !== undefined && { customerCity: raw.customerCity || null }),
      ...(raw.deliveryAddress !== undefined && { deliveryAddress: raw.deliveryAddress || null }),
      ...(raw.notes !== undefined && { notes: raw.notes || null }),
      ...(raw.paymentType !== undefined && { paymentType: raw.paymentType }),
      ...(raw.creditDueDate !== undefined && { creditDueDate: raw.creditDueDate ? new Date(raw.creditDueDate) : null }),
      ...(raw.creditNotes !== undefined && { creditNotes: raw.creditNotes || null }),
    };

    // Update items if provided
    if (raw.items && raw.items.length) {
      const products = await prisma.product.findMany({ where: { id: { in: raw.items.map(i => i.productId) }, companyId } });
      const productMap = {};
      products.forEach(p => { productMap[p.id] = p; });

      // Delete old items and create new ones
      await prisma.saleItem.deleteMany({ where: { saleId: req.params.id } });
      const saleItems = raw.items.map(item => {
        const product = productMap[item.productId];
        const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
        const qty = parseInt(item.qty);
        return { saleId: req.params.id, productId: item.productId, qty, unitPrice, costPrice: parseFloat(product.costPrice), totalPrice: qty * unitPrice };
      });
      await prisma.saleItem.createMany({ data: saleItems });

      const itemsTotal = saleItems.reduce((sum, i) => sum + i.totalPrice, 0);
      const discount = data.discount !== undefined ? data.discount : parseFloat(existing.discount);
      const shippingCharge = data.shippingCharge !== undefined ? data.shippingCharge : parseFloat(existing.shippingCharge);
      data.totalPrice = itemsTotal + shippingCharge - discount;
    }

    // Recalculate payment when paymentType changes
    if (raw.paymentType !== undefined) {
      const saleTotal = data.totalPrice || parseFloat(existing.totalPrice);
      if (raw.paymentType === 'Credit') {
        const deposit = raw.amountPaid !== undefined ? parseFloat(raw.amountPaid) || 0 : 0;
        data.amountPaid = deposit;
        if (deposit >= saleTotal) data.paymentStatus = 'Paid';
        else if (deposit > 0) data.paymentStatus = 'Partial';
        else data.paymentStatus = 'Unpaid';
      } else if (raw.paymentType === 'Cash') {
        data.amountPaid = data.totalPrice || parseFloat(existing.totalPrice);
        data.paymentStatus = 'Paid';
      }
    } else if (raw.amountPaid !== undefined && existing.paymentType === 'Credit') {
      const deposit = parseFloat(raw.amountPaid) || 0;
      const saleTotal = data.totalPrice || parseFloat(existing.totalPrice);
      data.amountPaid = deposit;
      if (deposit >= saleTotal) data.paymentStatus = 'Paid';
      else if (deposit > 0) data.paymentStatus = 'Partial';
      else data.paymentStatus = 'Unpaid';
    }

    const sale = await prisma.sale.update({ where: { id: req.params.id }, data, include: saleInclude });
    res.json(sale);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/:id/status', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { status } = req.body;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId }, include: { items: true } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const oldStatus = sale.status;
    const stockDeductStatuses = ['Confirmed', 'Shipped', 'Delivered'];
    const wasDeducted = stockDeductStatuses.includes(oldStatus);
    const shouldDeduct = stockDeductStatuses.includes(status);

    if (!wasDeducted && shouldDeduct) {
      for (const item of sale.items) {
        await prisma.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.qty } } });
        await prisma.stockLog.create({ data: { productId: item.productId, change: -item.qty, reason: 'Sale', saleId: sale.id, companyId } });
      }
    } else if (wasDeducted && !shouldDeduct) {
      for (const item of sale.items) {
        await prisma.product.update({ where: { id: item.productId }, data: { stock: { increment: item.qty } } });
        await prisma.stockLog.create({ data: { productId: item.productId, change: item.qty, reason: status === 'Cancelled' ? 'Cancelled Order' : 'Status Revert', saleId: sale.id, companyId } });
      }
    }

    const updated = await prisma.sale.update({ where: { id: req.params.id }, data: { status }, include: { ...saleInclude, statusHistory: { orderBy: { createdAt: 'desc' } } } });
    await prisma.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: oldStatus, toStatus: status, companyId } });
    res.json(updated);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId }, include: { items: true } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
      for (const item of sale.items) {
        await prisma.product.update({ where: { id: item.productId }, data: { stock: { increment: item.qty } } });
        await prisma.stockLog.create({ data: { productId: item.productId, change: item.qty, reason: 'Order Deleted', saleId: sale.id, companyId } });
      }
    }

    await prisma.creditPayment.deleteMany({ where: { saleId: req.params.id } });
    await prisma.debtReminder.deleteMany({ where: { saleId: req.params.id } });
    await prisma.orderStatusLog.deleteMany({ where: { saleId: req.params.id } });
    await prisma.saleItem.deleteMany({ where: { saleId: req.params.id } });
    await prisma.sale.delete({ where: { id: req.params.id } });
    res.json({ message: 'Sale deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CREDIT PAYMENTS ----
router.post('/:id/payments', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    await prisma.creditPayment.create({ data: { saleId: sale.id, amount, paymentMethod: req.body.paymentMethod || null, reference: req.body.reference || null, notes: req.body.notes || null, companyId } });

    const newAmountPaid = parseFloat(sale.amountPaid) + amount;
    const totalPrice = parseFloat(sale.totalPrice);
    const paymentStatus = newAmountPaid >= totalPrice ? 'Paid' : newAmountPaid > 0 ? 'Partial' : 'Unpaid';
    const updated = await prisma.sale.update({ where: { id: sale.id }, data: { amountPaid: newAmountPaid, paymentStatus }, include: { ...saleInclude, creditPayments: { orderBy: { createdAt: 'desc' } } } });
    res.json(updated);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id/payments', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const payments = await prisma.creditPayment.findMany({ where: { saleId: req.params.id, companyId }, orderBy: { createdAt: 'desc' } });
    res.json(payments);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- REMINDERS ----
router.post('/:id/reminders', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const reminder = await prisma.debtReminder.create({ data: { saleId: sale.id, channel: req.body.channel, message: req.body.message || null, companyId } });
    res.status(201).json(reminder);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id/reminders', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const reminders = await prisma.debtReminder.findMany({ where: { saleId: req.params.id, companyId }, orderBy: { sentAt: 'desc' } });
    res.json(reminders);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- RECEIPT DATA ----
router.get('/:id/receipt', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId }, include: { ...saleInclude, creditPayments: { orderBy: { createdAt: 'desc' } } } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });
    res.json({ sale, settings: settingsMap });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
