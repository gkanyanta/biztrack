const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// List products
router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { search, category, lowStock } = req.query;

    const where = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ];
    }
    if (category) where.category = category;
    if (lowStock === 'true') {
      where.stock = { lte: prisma.product.fields ? 5 : undefined };
    }

    let products = await prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });

    if (lowStock === 'true') {
      products = products.filter(p => p.stock <= p.reorderLevel);
    }

    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single product
router.get('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { stockLogs: { orderBy: { createdAt: 'desc' }, take: 50 } }
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get stock log for a product
router.get('/:id/stock-log', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const logs = await prisma.stockLog.findMany({
      where: { productId: req.params.id },
      orderBy: { createdAt: 'desc' }
    });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create product
router.post('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const data = req.body;

    // Auto-generate SKU if blank
    if (!data.sku) {
      const count = await prisma.product.count();
      data.sku = `SKU-${String(count + 1).padStart(4, '0')}`;
    }

    const product = await prisma.product.create({ data });

    // Log initial stock if any
    if (data.stock && data.stock > 0) {
      await prisma.stockLog.create({
        data: {
          productId: product.id,
          change: data.stock,
          reason: 'Initial Stock'
        }
      });
    }

    res.status(201).json(product);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(400).json({ error: 'SKU already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Update product
router.put('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Product not found' });

    const data = { ...req.body };
    const stockChange = data.stock !== undefined ? data.stock - existing.stock : 0;

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data
    });

    // Log stock change if stock was manually adjusted
    if (stockChange !== 0 && req.body.stock !== undefined) {
      await prisma.stockLog.create({
        data: {
          productId: product.id,
          change: stockChange,
          reason: 'Manual Adjustment'
        }
      });
    }

    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Soft delete product
router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.product.update({
      where: { id: req.params.id },
      data: { isActive: false }
    });
    res.json({ message: 'Product deactivated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk restock
router.post('/restock', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { items } = req.body; // [{ productId, quantity }]

    const results = [];
    for (const item of items) {
      const product = await prisma.product.update({
        where: { id: item.productId },
        data: { stock: { increment: item.quantity } }
      });

      await prisma.stockLog.create({
        data: {
          productId: item.productId,
          change: item.quantity,
          reason: 'Restock'
        }
      });

      results.push(product);
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get categories
router.get('/meta/categories', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const products = await prisma.product.findMany({
      where: { category: { not: null } },
      select: { category: true },
      distinct: ['category']
    });
    res.json(products.map(p => p.category).filter(Boolean));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
