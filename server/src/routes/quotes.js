const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const { validateQuote } = require('../middleware/validate');
const { parsePagination, paginatedResponse } = require('../utils/pagination');

router.use(authenticate);

const quoteInclude = { items: { include: { product: true } }, customer: true, consultant: { select: { id: true, name: true } } };
const OPEN_STATUSES = ['Sent', 'Accepted', 'Declined', 'Expired'];

async function nextQuoteNumber(prisma, companyId) {
  const last = await prisma.quote.findFirst({ where: { companyId }, orderBy: { createdAt: 'desc' } });
  let n = 1;
  if (last) { const m = last.quoteNumber.match(/QT-(\d+)/); if (m) n = parseInt(m[1]) + 1; }
  return `QT-${String(n).padStart(4, '0')}`;
}

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { status, search, from, to, sortBy, sortDir } = req.query;
    const where = { companyId };
    if (status) where.status = status;
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    if (search) { where.OR = [{ quoteNumber: { contains: search, mode: 'insensitive' } }, { customerName: { contains: search, mode: 'insensitive' } }, { customerPhone: { contains: search, mode: 'insensitive' } }]; }

    const pagination = parsePagination(req.query);
    if (!pagination) {
      const quotes = await prisma.quote.findMany({ where, include: quoteInclude, orderBy: { createdAt: 'desc' } });
      return res.json(quotes);
    }
    const orderBy = { [['date', 'totalPrice', 'status'].includes(sortBy) ? sortBy : 'createdAt']: sortDir === 'asc' ? 'asc' : 'desc' };
    const [total, quotes] = await Promise.all([
      prisma.quote.count({ where }),
      prisma.quote.findMany({ where, include: quoteInclude, orderBy, skip: pagination.skip, take: pagination.take }),
    ]);
    res.json(paginatedResponse(quotes, total, pagination));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const quote = await prisma.quote.findFirst({ where, include: quoteInclude });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    res.json(quote);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id/pdf-data', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const quote = await prisma.quote.findFirst({ where, include: quoteInclude });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    const settings = await prisma.setting.findMany({ where: { companyId } });
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });
    res.json({ quote, settings: settingsMap });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/', validateQuote, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const data = req.body;
    if (req.user.role === 'consultant') data.consultantId = req.user.consultantId;
    const items = data.items;

    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId } });
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });
    for (const item of items) {
      if (!productMap[item.productId]) return res.status(400).json({ error: `Product not found: ${item.productId}` });
    }

    const quoteNumber = await nextQuoteNumber(prisma, companyId);

    let customerId = data.customerId;
    if (!customerId && data.customerName) {
      let customer = null;
      if (data.customerPhone) customer = await prisma.customer.findFirst({ where: { phone: data.customerPhone, companyId } });
      if (!customer) customer = await prisma.customer.create({ data: { name: data.customerName, phone: data.customerPhone || null, city: data.customerCity || null, source: data.source || null, companyId } });
      customerId = customer.id;
    }

    const quoteItems = items.map(item => {
      const product = productMap[item.productId];
      const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
      const qty = parseInt(item.qty);
      return { productId: item.productId, qty, unitPrice, totalPrice: qty * unitPrice };
    });
    const itemsTotal = quoteItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const discount = parseFloat(data.discount) || 0;
    const shippingCharge = parseFloat(data.shippingCharge) || 0;
    const totalPrice = itemsTotal + shippingCharge - discount;

    // Default validity window: 7 days, unless the caller specifies one.
    let expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    if (!expiresAt) { expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 7); }

    const quote = await prisma.quote.create({
      data: {
        quoteNumber, date: data.date ? new Date(data.date) : new Date(), expiresAt,
        status: 'Sent', shippingCharge, discount, totalPrice, notes: data.notes || null,
        consultantId: data.consultantId || null,
        customerId, customerName: data.customerName || null, customerPhone: data.customerPhone || null, customerCity: data.customerCity || null,
        companyId,
        items: { create: quoteItems },
      },
      include: quoteInclude,
    });
    res.status(201).json(quote);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/:id', validateQuote, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const existing = await prisma.quote.findFirst({ where });
    if (!existing) return res.status(404).json({ error: 'Quote not found' });
    if (existing.status === 'Converted') return res.status(400).json({ error: 'Cannot edit a quote that has already been converted to a sale' });

    const data = req.body;
    const items = data.items;
    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId } });
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });
    for (const item of items) {
      if (!productMap[item.productId]) return res.status(400).json({ error: `Product not found: ${item.productId}` });
    }
    const quoteItems = items.map(item => {
      const product = productMap[item.productId];
      const unitPrice = parseFloat(item.unitPrice) || parseFloat(product.sellingPrice);
      const qty = parseInt(item.qty);
      return { productId: item.productId, qty, unitPrice, totalPrice: qty * unitPrice };
    });
    const itemsTotal = quoteItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const discount = parseFloat(data.discount) || 0;
    const shippingCharge = parseFloat(data.shippingCharge) || 0;
    const totalPrice = itemsTotal + shippingCharge - discount;

    const quote = await prisma.$transaction(async (tx) => {
      await tx.quoteItem.deleteMany({ where: { quoteId: existing.id } });
      return tx.quote.update({
        where: { id: existing.id },
        data: {
          date: data.date ? new Date(data.date) : existing.date,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : existing.expiresAt,
          shippingCharge, discount, totalPrice, notes: data.notes || null,
          customerId: data.customerId || existing.customerId,
          customerName: data.customerName || null, customerPhone: data.customerPhone || null, customerCity: data.customerCity || null,
          items: { create: quoteItems },
        },
        include: quoteInclude,
      });
    });
    res.json(quote);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/:id/status', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { status } = req.body;
    if (!OPEN_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${OPEN_STATUSES.join(', ')}` });
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const existing = await prisma.quote.findFirst({ where });
    if (!existing) return res.status(404).json({ error: 'Quote not found' });
    if (existing.status === 'Converted') return res.status(400).json({ error: 'This quote has already been converted to a sale' });
    const quote = await prisma.quote.update({ where: { id: existing.id }, data: { status }, include: quoteInclude });
    res.json(quote);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- CONVERT TO SALE ----
// The payoff feature: turns an accepted quote into a real order in one step, honoring the
// quoted prices exactly (costPrice is re-read from the live product so COGS stays accurate
// even if supplier cost changed since the quote was issued). New sale lands in 'Pending' —
// same as any freshly created sale — so no stock or commission side effects fire until
// someone explicitly confirms it.
router.post('/:id/convert', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const where = { id: req.params.id, companyId };
    if (req.user.role === 'consultant') where.consultantId = req.user.consultantId;
    const quote = await prisma.quote.findFirst({ where, include: { items: true } });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    if (quote.status === 'Converted' || quote.convertedSaleId) return res.status(400).json({ error: 'This quote has already been converted to a sale' });

    const productIds = quote.items.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, companyId } });
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });
    for (const item of quote.items) {
      if (!productMap[item.productId]) return res.status(400).json({ error: 'One of the quoted products no longer exists' });
    }

    const sale = await prisma.$transaction(async (tx) => {
      const lastSale = await tx.sale.findFirst({ where: { companyId }, orderBy: { createdAt: 'desc' } });
      let nextNum = 1;
      if (lastSale) { const m = lastSale.orderNumber.match(/ORD-(\d+)/); if (m) nextNum = parseInt(m[1]) + 1; }
      const orderNumber = `ORD-${String(nextNum).padStart(4, '0')}`;

      const saleItems = quote.items.map(item => ({
        productId: item.productId, qty: item.qty, unitPrice: parseFloat(item.unitPrice),
        costPrice: parseFloat(productMap[item.productId].costPrice), totalPrice: parseFloat(item.totalPrice),
      }));

      const created = await tx.sale.create({
        data: {
          orderNumber, date: new Date(), totalPrice: quote.totalPrice,
          shippingCharge: quote.shippingCharge, discount: quote.discount,
          status: 'Pending', paymentStatus: 'Unpaid', paymentType: 'Cash',
          consultantId: quote.consultantId,
          customerId: quote.customerId, customerName: quote.customerName, customerPhone: quote.customerPhone, customerCity: quote.customerCity,
          notes: `Converted from quote ${quote.quoteNumber}`,
          companyId,
          items: { create: saleItems },
        },
      });
      await tx.orderStatusLog.create({ data: { saleId: created.id, fromStatus: 'New', toStatus: 'Pending', companyId } });
      await tx.quote.update({ where: { id: quote.id }, data: { status: 'Converted', convertedSaleId: created.id } });
      return created;
    }, { timeout: 20000 });

    res.status(201).json(sale);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.quote.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Quote not found' });
    if (existing.status === 'Converted') return res.status(400).json({ error: 'Cannot delete a quote that has been converted to a sale — cancel the sale instead' });
    await prisma.quote.delete({ where: { id: req.params.id } });
    res.json({ message: 'Quote deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
