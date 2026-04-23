const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const { validateProduct } = require('../middleware/validate');

router.use(authenticate);

function stripForConsultant(products) {
  return products.map(({ costPrice, supplier, reorderLevel, ...rest }) => rest);
}

router.get('/meta/categories', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const products = await prisma.product.findMany({ where: { companyId, category: { not: null } }, select: { category: true }, distinct: ['category'] });
    res.json(products.map(p => p.category).filter(Boolean));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { search, category, lowStock } = req.query;
    const where = { companyId };
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }]; }
    if (category) where.category = category;
    let products = await prisma.product.findMany({
      where,
      select: { id: true, name: true, sku: true, description: true, category: true, costPrice: true, sellingPrice: true, originalPrice: true, stock: true, reorderLevel: true, supplier: true, isActive: true, createdAt: true, updatedAt: true, companyId: true },
    });
    const withImages = await prisma.product.findMany({ where: { ...where, imageUrl: { not: null } }, select: { id: true } });
    const imageIds = new Set(withImages.map(p => p.id));

    // Sales velocity over the last 90 days, aggregated per product
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const velocityRows = products.length
      ? await prisma.saleItem.groupBy({
          by: ['productId'],
          where: { productId: { in: products.map(p => p.id) }, sale: { companyId, date: { gte: since } } },
          _sum: { qty: true },
        })
      : [];
    const velocityMap = new Map(velocityRows.map(v => [v.productId, v._sum.qty || 0]));

    products = products
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
    if (lowStock === 'true') products = products.filter(p => p.stock <= p.reorderLevel);
    if (req.user.role === 'consultant') products = stripForConsultant(products);
    res.json(products);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const product = await prisma.product.findFirst({ where: { id: req.params.id, companyId }, include: { stockLogs: { orderBy: { createdAt: 'desc' }, take: 50 } } });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (req.user.role === 'consultant') {
      const { costPrice, supplier, reorderLevel, stockLogs, ...rest } = product;
      return res.json(rest);
    }
    res.json(product);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id/stock-log', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const logs = await prisma.stockLog.findMany({ where: { productId: req.params.id, companyId }, orderBy: { createdAt: 'desc' } });
    res.json(logs);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/', requireAdmin, validateProduct, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const data = { ...req.body, companyId };
    if (!data.sku) { const count = await prisma.product.count({ where: { companyId } }); data.sku = `SKU-${String(count + 1).padStart(4, '0')}`; }
    const product = await prisma.product.create({ data });
    if (data.stock && data.stock > 0) { await prisma.stockLog.create({ data: { productId: product.id, change: data.stock, reason: 'Initial Stock', companyId } }); }
    res.status(201).json(product);
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'SKU already exists' });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
});

router.put('/:id', requireAdmin, validateProduct, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.product.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    const data = { ...req.body };
    delete data.companyId;
    if (data.imageUrl !== undefined && data.imageUrl !== null && data.imageUrl !== '' && !/^data:image\//.test(data.imageUrl)) {
      delete data.imageUrl;
    }
    const stockChange = data.stock !== undefined ? data.stock - existing.stock : 0;
    const product = await prisma.product.update({ where: { id: req.params.id }, data });
    if (stockChange !== 0 && req.body.stock !== undefined) {
      await prisma.stockLog.create({ data: { productId: product.id, change: stockChange, reason: 'Manual Adjustment', companyId } });
    }
    res.json(product);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const product = await prisma.product.findFirst({ where: { id: req.params.id, companyId } });
    if (!product) return res.status(404).json({ error: 'Not found' });
    await prisma.product.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ message: 'Product deactivated' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/restock', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { items } = req.body;
    const results = [];
    for (const item of items) {
      const product = await prisma.product.findFirst({ where: { id: item.productId, companyId } });
      if (!product) continue;
      const updated = await prisma.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
      await prisma.stockLog.create({ data: { productId: item.productId, change: item.quantity, reason: 'Restock', companyId } });
      results.push(updated);
    }
    res.json(results);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
