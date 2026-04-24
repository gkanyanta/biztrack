const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { validateSale } = require('../middleware/validate');

router.use(authenticate);

const saleInclude = { items: { include: { product: true, stockSourceConsultant: { select: { id: true, name: true } } } }, customer: true, consultant: true };

// ---- Stock source helpers ----
// Deduct stock for a single sale item, respecting explicit stockSourceConsultantId.
// Falls back to legacy heuristic (try sale.consultantId then main) for items with no explicit source.
// Throws { status, message } on insufficient stock.
async function deductStockForItem(prisma, item, sale, companyId) {
  const sourceId = item.stockSourceConsultantId;

  if (sourceId) {
    const cStock = await prisma.consultantStock.findUnique({
      where: { consultantId_productId: { consultantId: sourceId, productId: item.productId } }
    });
    if (!cStock || cStock.qty < item.qty) {
      const consultant = await prisma.consultant.findUnique({ where: { id: sourceId }, select: { name: true } });
      const err = new Error(`${consultant?.name || 'Consultant'} has ${cStock?.qty || 0} units; ${item.qty} needed`);
      err.status = 400;
      throw err;
    }
    await prisma.consultantStock.update({
      where: { consultantId_productId: { consultantId: sourceId, productId: item.productId } },
      data: { qty: { decrement: item.qty } }
    });
    const consultant = await prisma.consultant.findUnique({ where: { id: sourceId }, select: { name: true } });
    await prisma.stockLog.create({
      data: { productId: item.productId, change: -item.qty, reason: `Sale (from ${consultant?.name || 'consultant'})`, saleId: sale.id, companyId }
    });
    return;
  }

  // Legacy fallback (items with no explicit source): try sale's consultant first if present.
  if (sale.consultantId) {
    const cStock = await prisma.consultantStock.findUnique({
      where: { consultantId_productId: { consultantId: sale.consultantId, productId: item.productId } }
    });
    if (cStock && cStock.qty >= item.qty) {
      await prisma.consultantStock.update({
        where: { consultantId_productId: { consultantId: sale.consultantId, productId: item.productId } },
        data: { qty: { decrement: item.qty } }
      });
      await prisma.stockLog.create({
        data: { productId: item.productId, change: -item.qty, reason: 'Sale (consultant stock)', saleId: sale.id, companyId }
      });
      return;
    }
  }

  await prisma.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.qty } } });
  await prisma.stockLog.create({
    data: { productId: item.productId, change: -item.qty, reason: 'Sale (from Main)', saleId: sale.id, companyId }
  });
}

// Refund stock for a single sale item back to the original source.
// Explicit source wins; else mirror the deduction heuristic (sale's consultant if set, else main).
async function refundStockForItem(prisma, item, sale, companyId, reason) {
  const sourceId = item.stockSourceConsultantId || sale.consultantId || null;
  if (sourceId) {
    await prisma.consultantStock.upsert({
      where: { consultantId_productId: { consultantId: sourceId, productId: item.productId } },
      update: { qty: { increment: item.qty } },
      create: { consultantId: sourceId, productId: item.productId, qty: item.qty, companyId }
    });
    const consultant = await prisma.consultant.findUnique({ where: { id: sourceId }, select: { name: true } });
    await prisma.stockLog.create({
      data: { productId: item.productId, change: item.qty, reason: `${reason} (to ${consultant?.name || 'consultant'})`, saleId: sale.id, companyId }
    });
    return;
  }
  await prisma.product.update({ where: { id: item.productId }, data: { stock: { increment: item.qty } } });
  await prisma.stockLog.create({
    data: { productId: item.productId, change: item.qty, reason, saleId: sale.id, companyId }
  });
}

// Consultants can only select their own stock or Main (null). Admins can select any.
function normalizeItemStockSource(item, user) {
  let src = item.stockSourceConsultantId || null;
  if (user.role === 'consultant' && src && src !== user.consultantId) {
    const err = new Error('Consultants can only sell from their own stock or request Main fulfillment');
    err.status = 403;
    throw err;
  }
  return src;
}

// ---- CREDIT SUMMARY (must be before /:id routes) ----
router.get('/credit/summary', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const saleWhere = { companyId, paymentType: 'Credit', paymentStatus: { not: 'Paid' } };
    if (req.user.role === 'consultant') saleWhere.consultantId = req.user.consultantId;
    const creditSales = await prisma.sale.findMany({ where: saleWhere, include: { customer: true } });
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
    const paymentWhere = { companyId };
    if (req.user.role === 'consultant') paymentWhere.sale = { consultantId: req.user.consultantId };
    const recentPayments = await prisma.creditPayment.findMany({ where: paymentWhere, orderBy: { createdAt: 'desc' }, take: 10, include: { sale: { select: { orderNumber: true, customerName: true } } } });
    res.json({ totalOutstanding, overdueCount, overdueAmount, topDebtors, recentPayments });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { status, paymentStatus, paymentType, from, to, customerId, consultantId, search, creditOverdue } = req.query;
    const where = { companyId };
    if (status) where.status = status;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (paymentType) where.paymentType = paymentType;
    if (customerId) where.customerId = customerId;
    if (consultantId) where.consultantId = consultantId;
    // Consultants only see their own sales
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
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
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where, include: { ...saleInclude, statusHistory: { orderBy: { createdAt: 'desc' } }, creditPayments: { orderBy: { createdAt: 'desc' } }, debtReminders: { orderBy: { sentAt: 'desc' } } } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    // Strip cost-exposing fields for consultants
    if (req.user.role === 'consultant') {
      sale.items = (sale.items || []).map(({ costPrice, ...rest }) => rest);
    }
    res.json(sale);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/', validateSale, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const data = req.body;
    // Consultants can only create sales attributed to themselves
    if (req.user.role === 'consultant') data.consultantId = req.user.consultantId;
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
    let saleItems;
    try {
      saleItems = items.map(item => {
        const product = productMap[item.productId];
        const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
        const qty = parseInt(item.qty);
        const stockSourceConsultantId = normalizeItemStockSource(item, req.user);
        return { productId: item.productId, qty, unitPrice, costPrice: parseFloat(product.costPrice), totalPrice: qty * unitPrice, serialNumber: item.serialNumber || null, stockSourceConsultantId };
      });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
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

    try {
      const sale = await prisma.$transaction(async (tx) => {
        const created = await tx.sale.create({
          data: {
            orderNumber, date: data.date ? new Date(data.date) : new Date(),
            totalPrice, shippingCost, shippingCharge, discount,
            status: data.status || 'Pending', paymentStatus, paymentMethod: data.paymentMethod || null, source: data.source || null,
            paymentType, amountPaid, creditDueDate: data.creditDueDate ? new Date(data.creditDueDate) : null, creditNotes: data.creditNotes || null,
            consultantId: data.consultantId || null,
            customerId, customerName: data.customerName || null, customerPhone: data.customerPhone || null, customerCity: data.customerCity || null,
            deliveryAddress: data.deliveryAddress || null, notes: data.notes || null, companyId,
            items: { create: saleItems },
          },
          include: saleInclude,
        });
        if (['Confirmed', 'Shipped', 'Delivered'].includes(created.status)) {
          for (const item of created.items) {
            await deductStockForItem(tx, item, created, companyId);
          }
        }
        await tx.orderStatusLog.create({ data: { saleId: created.id, fromStatus: 'New', toStatus: created.status, companyId } });
        return created;
      }, { timeout: 20000 });
      res.status(201).json(sale);
    } catch (e) {
      console.error(e);
      return res.status(e.status || 500).json({ error: e.message || 'Something went wrong' });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const raw = req.body;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const existing = await prisma.sale.findFirst({ where, include: { items: true } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    // Consultants can't reassign a sale to another consultant
    if (req.user.role === 'consultant') raw.consultantId = req.user.consultantId;

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
      ...(raw.consultantId !== undefined && { consultantId: raw.consultantId || null }),
    };

    // Build new items (no DB writes yet — we want to validate before touching anything).
    let newSaleItems = null;
    if (raw.items && raw.items.length) {
      const products = await prisma.product.findMany({ where: { id: { in: raw.items.map(i => i.productId) }, companyId } });
      const productMap = {};
      products.forEach(p => { productMap[p.id] = p; });

      try {
        newSaleItems = raw.items.map(item => {
          const product = productMap[item.productId];
          if (!product) { const err = new Error(`Product not found: ${item.productId}`); err.status = 400; throw err; }
          const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
          const qty = parseInt(item.qty);
          const stockSourceConsultantId = normalizeItemStockSource(item, req.user);
          return { saleId: req.params.id, productId: item.productId, qty, unitPrice, costPrice: parseFloat(product.costPrice), totalPrice: qty * unitPrice, serialNumber: item.serialNumber || null, stockSourceConsultantId };
        });
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message });
      }

      const itemsTotal = newSaleItems.reduce((sum, i) => sum + i.totalPrice, 0);
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

    const deductStatuses = ['Confirmed', 'Shipped', 'Delivered'];
    const wasDeducted = deductStatuses.includes(existing.status);

    try {
      const sale = await prisma.$transaction(async (tx) => {
        if (newSaleItems) {
          // If the sale was already deducted, refund old items to their original sources first.
          if (wasDeducted) {
            for (const oldItem of existing.items) {
              await refundStockForItem(tx, oldItem, existing, companyId, 'Edit Revert');
            }
          }
          await tx.saleItem.deleteMany({ where: { saleId: req.params.id } });
          await tx.saleItem.createMany({ data: newSaleItems });
          // If still in a deducted state, re-deduct from the new sources.
          if (wasDeducted) {
            const saleCtx = { id: req.params.id, consultantId: data.consultantId !== undefined ? data.consultantId : existing.consultantId };
            for (const newItem of newSaleItems) {
              await deductStockForItem(tx, newItem, saleCtx, companyId);
            }
          }
        }
        return tx.sale.update({ where: { id: req.params.id }, data, include: saleInclude });
      }, { timeout: 20000 });
      res.json(sale);
    } catch (e) {
      console.error(e);
      return res.status(e.status || 500).json({ error: e.message || 'Something went wrong' });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/:id/status', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { status } = req.body;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where, include: { items: true } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const oldStatus = sale.status;
    const stockDeductStatuses = ['Confirmed', 'Shipped', 'Delivered'];
    const wasDeducted = stockDeductStatuses.includes(oldStatus);
    const shouldDeduct = stockDeductStatuses.includes(status);

    try {
      const updated = await prisma.$transaction(async (tx) => {
        if (!wasDeducted && shouldDeduct) {
          for (const item of sale.items) {
            await deductStockForItem(tx, item, sale, companyId);
          }
        } else if (wasDeducted && !shouldDeduct) {
          const reason = status === 'Cancelled' ? 'Cancelled Order' : 'Status Revert';
          for (const item of sale.items) {
            await refundStockForItem(tx, item, sale, companyId, reason);
          }
        }
        const result = await tx.sale.update({ where: { id: req.params.id }, data: { status }, include: { ...saleInclude, statusHistory: { orderBy: { createdAt: 'desc' } } } });
        await tx.orderStatusLog.create({ data: { saleId: sale.id, fromStatus: oldStatus, toStatus: status, companyId } });
        return result;
      }, { timeout: 20000 });
      res.json(updated);
    } catch (e) {
      console.error(e);
      return res.status(e.status || 500).json({ error: e.message || 'Something went wrong' });
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    // Consultants cannot delete sales
    if (req.user.role === 'consultant') return res.status(403).json({ error: 'Consultants cannot delete sales' });
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const sale = await prisma.sale.findFirst({ where: { id: req.params.id, companyId }, include: { items: true } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    await prisma.$transaction(async (tx) => {
      if (['Confirmed', 'Shipped', 'Delivered'].includes(sale.status)) {
        for (const item of sale.items) {
          await refundStockForItem(tx, item, sale, companyId, 'Order Deleted');
        }
      }
      await tx.creditPayment.deleteMany({ where: { saleId: req.params.id } });
      await tx.debtReminder.deleteMany({ where: { saleId: req.params.id } });
      await tx.orderStatusLog.deleteMany({ where: { saleId: req.params.id } });
      await tx.saleItem.deleteMany({ where: { saleId: req.params.id } });
      await tx.sale.delete({ where: { id: req.params.id } });
    }, { timeout: 20000 });
    res.json({ message: 'Sale deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CREDIT PAYMENTS ----
router.post('/:id/payments', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where });
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
    if (req.user.role === 'consultant') {
      const owned = await prisma.sale.findFirst({ where: { id: req.params.id, companyId, consultantId: req.user.consultantId }, select: { id: true } });
      if (!owned) return res.status(404).json({ error: 'Sale not found' });
    }
    const payments = await prisma.creditPayment.findMany({ where: { saleId: req.params.id, companyId }, orderBy: { createdAt: 'desc' } });
    res.json(payments);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- REMINDERS ----
router.post('/:id/reminders', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const reminder = await prisma.debtReminder.create({ data: { saleId: sale.id, channel: req.body.channel, message: req.body.message || null, companyId } });
    res.status(201).json(reminder);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id/reminders', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    if (req.user.role === 'consultant') {
      const owned = await prisma.sale.findFirst({ where: { id: req.params.id, companyId, consultantId: req.user.consultantId }, select: { id: true } });
      if (!owned) return res.status(404).json({ error: 'Sale not found' });
    }
    const reminders = await prisma.debtReminder.findMany({ where: { saleId: req.params.id, companyId }, orderBy: { sentAt: 'desc' } });
    res.json(reminders);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- RECEIPT DATA ----
router.get('/:id/receipt', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const sale = await prisma.sale.findFirst({ where, include: { ...saleInclude, creditPayments: { orderBy: { createdAt: 'desc' } } } });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });
    res.json({ sale, settings: settingsMap });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
