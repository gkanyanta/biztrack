const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { status, paymentStatus, from, to, customerId, search } = req.query;
    const where = { companyId };
    if (status) where.status = status;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (customerId) where.customerId = customerId;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    if (search) { where.OR = [{ orderNumber: { contains: search, mode: 'insensitive' } }, { customerName: { contains: search, mode: 'insensitive' } }, { customerPhone: { contains: search, mode: 'insensitive' } }]; }
    const sales = await prisma.sale.findMany({ where, include: { product: true, customer: true }, orderBy: { createdAt: 'desc' } });
    res.json(sales);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId }, include: { product: true, customer: true, statusHistory: { orderBy: { createdAt: 'desc' } } } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    res.json(sale);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const data = req.body;

    const product = await prisma.product.findFirst({ where: { id: data.productId, companyId } });
    if (!product) return res.status(400).json({ error: 'Product not found' });

    const lastSale = await prisma.sale.findFirst({ where: { companyId }, orderBy: { createdAt: 'desc' } });
    let nextNum = 1;
    if (lastSale) { const match = lastSale.orderNumber.match(/ORD-(\d+)/); if (match) nextNum = parseInt(match[1]) + 1; }
    const orderNumber = `ORD-${String(nextNum).padStart(4, '0')}`;

    let customerId = data.customerId;
    if (!customerId && data.customerName) {
      let customer = null;
      if (data.customerPhone) customer = await prisma.customer.findFirst({ where: { phone: data.customerPhone, companyId } });
      if (!customer) customer = await prisma.customer.create({ data: { name: data.customerName, phone: data.customerPhone || null, city: data.customerCity || null, source: data.source || null, companyId } });
      customerId = customer.id;
    }

    let shippingCost = parseFloat(data.shippingCost) || 0;
    if (data.customerCity && !data.shippingCost) {
      const rate = await prisma.shippingRate.findFirst({ where: { city: data.customerCity, companyId } });
      if (rate) shippingCost = parseFloat(rate.rate);
    }

    const unitPrice = parseFloat(data.unitPrice) || parseFloat(product.sellingPrice);
    const qty = parseInt(data.qty);
    const totalPrice = qty * unitPrice;

    const sale = await prisma.sale.create({
      data: {
        orderNumber, date: data.date ? new Date(data.date) : new Date(), productId: data.productId, qty, unitPrice, costPrice: parseFloat(product.costPrice), totalPrice,
        shippingCost, shippingCharge: parseFloat(data.shippingCharge) || 0, discount: parseFloat(data.discount) || 0,
        status: data.status || 'Pending', paymentStatus: data.paymentStatus || 'Unpaid', paymentMethod: data.paymentMethod || null, source: data.source || null,
        customerId, customerName: data.customerName || null, customerPhone: data.customerPhone || null, customerCity: data.customerCity || null, deliveryAddress: data.deliveryAddress || null, notes: data.notes || null,
        companyId
      },
      include: { product: true, customer: true }
    });

    if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
      await prisma.product.update({ where: { id: data.productId }, data: { stock: { decrement: qty } } });
      await prisma.stockLog.create({ data: { productId: data.productId, change: -qty, reason: 'Sale', saleId: sale.id, companyId } });
    }

    await prisma.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: 'New', toStatus: sale.status, companyId } });
    res.status(201).json(sale);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const raw = req.body;
    const existing = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const qty = raw.qty !== undefined ? parseInt(raw.qty) : existing.qty;
    const unitPrice = raw.unitPrice !== undefined ? parseFloat(raw.unitPrice) : parseFloat(existing.unitPrice);

    const data = {
      ...(raw.productId && { productId: raw.productId }), qty, unitPrice, totalPrice: qty * unitPrice,
      shippingCost: raw.shippingCost !== undefined ? parseFloat(raw.shippingCost) || 0 : undefined,
      shippingCharge: raw.shippingCharge !== undefined ? parseFloat(raw.shippingCharge) || 0 : undefined,
      discount: raw.discount !== undefined ? parseFloat(raw.discount) || 0 : undefined,
      ...(raw.date && { date: new Date(raw.date) }),
      ...(raw.paymentMethod !== undefined && { paymentMethod: raw.paymentMethod || null }),
      ...(raw.paymentStatus && { paymentStatus: raw.paymentStatus }),
      ...(raw.source !== undefined && { source: raw.source || null }),
      ...(raw.customerName !== undefined && { customerName: raw.customerName || null }),
      ...(raw.customerPhone !== undefined && { customerPhone: raw.customerPhone || null }),
      ...(raw.customerCity !== undefined && { customerCity: raw.customerCity || null }),
      ...(raw.deliveryAddress !== undefined && { deliveryAddress: raw.deliveryAddress || null }),
      ...(raw.notes !== undefined && { notes: raw.notes || null }),
    };
    Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);
    const sale = await prisma.sale.update({ where: { id: req.params.id }, data, include: { product: true, customer: true } });
    res.json(sale);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id/status', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { status } = req.body;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const oldStatus = sale.status;
    const stockDeductStatuses = ['Confirmed', 'Shipped', 'Delivered'];
    const wasDeducted = stockDeductStatuses.includes(oldStatus);
    const shouldDeduct = stockDeductStatuses.includes(status);
    if (!wasDeducted && shouldDeduct) {
      await prisma.product.update({ where: { id: sale.productId }, data: { stock: { decrement: sale.qty } } });
      await prisma.stockLog.create({ data: { productId: sale.productId, change: -sale.qty, reason: 'Sale', saleId: sale.id, companyId } });
    } else if (wasDeducted && !shouldDeduct) {
      await prisma.product.update({ where: { id: sale.productId }, data: { stock: { increment: sale.qty } } });
      await prisma.stockLog.create({ data: { productId: sale.productId, change: sale.qty, reason: status === 'Cancelled' ? 'Cancelled Order' : 'Status Revert', saleId: sale.id, companyId } });
    }
    const updated = await prisma.sale.update({ where: { id: req.params.id }, data: { status }, include: { product: true, customer: true, statusHistory: { orderBy: { createdAt: 'desc' } } } });
    await prisma.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: oldStatus, toStatus: status, companyId } });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
      await prisma.product.update({ where: { id: sale.productId }, data: { stock: { increment: sale.qty } } });
      await prisma.stockLog.create({ data: { productId: sale.productId, change: sale.qty, reason: 'Order Deleted', saleId: sale.id, companyId } });
    }
    await prisma.orderStatusLog.deleteMany({ where: { saleId: req.params.id } });
    await prisma.sale.delete({ where: { id: req.params.id } });
    res.json({ message: 'Sale deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
