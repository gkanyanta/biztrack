const router = require('express').Router();
const { authenticate, requireAdmin, requireAdminOrInventory } = require('../middleware/auth');
const { validateProduct } = require('../middleware/validate');
const { preventDuplicateSubmit } = require('../middleware/dedupe');
const { parsePagination, paginatedResponse } = require('../utils/pagination');

router.use(authenticate);

function stripForConsultant(products) {
  return products.map(({ costPrice, supplier, reorderLevel, ...rest }) => rest);
}

// Inventory role needs reorderLevel (their job is watching stock levels) but not cost/supplier.
function stripForInventory(products) {
  return products.map(({ costPrice, supplier, ...rest }) => rest);
}

const PRODUCT_SELECT = { id: true, name: true, sku: true, description: true, category: true, costPrice: true, sellingPrice: true, originalPrice: true, stock: true, reorderLevel: true, supplier: true, isActive: true, createdAt: true, updatedAt: true, companyId: true, groupId: true, variantLabel: true, group: { select: { id: true, name: true } } };
const PRODUCT_SORT_FIELDS = ['name', 'sku', 'category', 'costPrice', 'sellingPrice', 'stock', 'createdAt'];

async function attachImages(prisma, companyId, products) {
  if (!products.length) return products;
  const withImages = await prisma.product.findMany({ where: { companyId, id: { in: products.map(p => p.id) }, imageUrl: { not: null } }, select: { id: true } });
  const imageIds = new Set(withImages.map(p => p.id));
  return products.map(p => ({ ...p, imageUrl: imageIds.has(p.id) ? `/api/v1/store/product-image/${p.id}` : null }));
}

router.get('/meta/categories', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const products = await prisma.product.findMany({ where: { companyId, category: { not: null } }, select: { category: true }, distinct: ['category'] });
    res.json(products.map(p => p.category).filter(Boolean));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// ---- PRODUCT GROUPS (variant families, e.g. "T-Shirt" grouping Red/Blue/Green) ----
// Registered before /:id so Express doesn't treat "groups" as a product id.
router.get('/groups', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const groups = await prisma.productGroup.findMany({
      where: { companyId },
      orderBy: { name: 'asc' },
      include: { products: { select: { id: true, name: true, variantLabel: true, sku: true, stock: true, isActive: true } } },
    });
    res.json(groups);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/groups', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Group name is required' });
    const group = await prisma.productGroup.create({ data: { name, companyId } });
    res.status(201).json(group);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/groups/:id', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.productGroup.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Group not found' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Group name is required' });
    const group = await prisma.productGroup.update({ where: { id: req.params.id }, data: { name } });
    res.json(group);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { search, category, lowStock, sortBy, sortDir } = req.query;
    const where = { companyId };
    if (search) { where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }]; }
    if (category) where.category = category;

    const pagination = parsePagination(req.query);

    // Plain column sorts with no low-stock filter can be pushed straight to the DB —
    // skips the velocity computation entirely and only touches the requested page.
    const canPushSort = pagination && sortBy && PRODUCT_SORT_FIELDS.includes(sortBy) && lowStock !== 'true';
    if (canPushSort) {
      const [total, rows] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({ where, select: PRODUCT_SELECT, orderBy: { [sortBy]: sortDir === 'desc' ? 'desc' : 'asc' }, skip: pagination.skip, take: pagination.take }),
      ]);
      let products = await attachImages(prisma, companyId, rows);
      if (req.user.role === 'consultant') products = stripForConsultant(products);
      else if (req.user.role === 'inventory') products = stripForInventory(products);
      return res.json(paginatedResponse(products, total, pagination));
    }

    // Default ordering (on-sale first, then 90-day sales velocity) and margin sort are both
    // derived across the whole filtered set, so they can't be expressed as a DB orderBy —
    // compute once, then slice the requested page before responding.
    let products = await prisma.product.findMany({ where, select: PRODUCT_SELECT });
    products = await attachImages(prisma, companyId, products);

    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const velocityRows = products.length
      ? await prisma.saleItem.groupBy({
          by: ['productId'],
          where: { productId: { in: products.map(p => p.id) }, sale: { companyId, date: { gte: since } } },
          _sum: { qty: true },
        })
      : [];
    const velocityMap = new Map(velocityRows.map(v => [v.productId, v._sum.qty || 0]));

    products = products.map(p => {
      const onSale = p.originalPrice != null && parseFloat(p.originalPrice) > parseFloat(p.sellingPrice);
      const margin = parseFloat(p.sellingPrice) > 0 ? (parseFloat(p.sellingPrice) - parseFloat(p.costPrice)) / parseFloat(p.sellingPrice) : 0;
      return { ...p, _onSale: onSale, _velocity: velocityMap.get(p.id) || 0, _margin: margin };
    });

    if (sortBy === 'margin') {
      products.sort((a, b) => sortDir === 'desc' ? b._margin - a._margin : a._margin - b._margin);
    } else {
      products.sort((a, b) => {
        if (a._onSale !== b._onSale) return a._onSale ? -1 : 1;
        if (a._velocity !== b._velocity) return b._velocity - a._velocity;
        return a.name.localeCompare(b.name);
      });
    }
    products = products.map(({ _onSale, _velocity, _margin, ...rest }) => rest);

    if (lowStock === 'true') products = products.filter(p => p.stock <= p.reorderLevel);
    if (req.user.role === 'consultant') products = stripForConsultant(products);
    else if (req.user.role === 'inventory') products = stripForInventory(products);

    if (pagination) {
      const total = products.length;
      const pageRows = products.slice(pagination.skip, pagination.skip + pagination.take);
      return res.json(paginatedResponse(pageRows, total, pagination));
    }
    res.json(products);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const product = await prisma.product.findFirst({ where: { id: req.params.id, companyId }, include: { stockLogs: { orderBy: { createdAt: 'desc' }, take: 50 }, group: true } });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (req.user.role === 'consultant') {
      const { costPrice, supplier, reorderLevel, stockLogs, ...rest } = product;
      return res.json(rest);
    }
    if (req.user.role === 'inventory') {
      const { costPrice, supplier, ...rest } = product;
      return res.json(rest);
    }
    res.json(product);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/:id/stock-log', requireAdminOrInventory, async (req, res) => {
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
    if (data.groupId) {
      const group = await prisma.productGroup.findFirst({ where: { id: data.groupId, companyId } });
      if (!group) return res.status(400).json({ error: 'Invalid product group' });
    }
    if (!data.sku) { const count = await prisma.product.count({ where: { companyId } }); data.sku = `SKU-${String(count + 1).padStart(4, '0')}`; }
    const product = await prisma.product.create({ data });
    if (data.stock && data.stock > 0) {
      await prisma.stockLog.create({ data: { productId: product.id, change: data.stock, reason: 'Initial Stock', companyId } });
      await prisma.expense.create({ data: { description: `Stock purchase: ${product.name} (${data.stock} units)`, amount: parseFloat(product.costPrice) * data.stock, category: 'Stock Purchase', companyId } });
    }
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
    if (data.groupId) {
      const group = await prisma.productGroup.findFirst({ where: { id: data.groupId, companyId } });
      if (!group) return res.status(400).json({ error: 'Invalid product group' });
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

router.post('/restock', requireAdminOrInventory, preventDuplicateSubmit, async (req, res) => {
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
      await prisma.expense.create({ data: { description: `Restock: ${product.name} (${item.quantity} units)`, amount: parseFloat(product.costPrice) * item.quantity, category: 'Stock Purchase', companyId } });
      results.push(updated);
    }
    res.json(results);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
