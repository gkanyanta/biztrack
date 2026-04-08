const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { category, search } = req.query;

    // Build filter
    const where = { companyId, isActive: true };
    if (category) where.category = category;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Get all active products with their stock logs
    const products = await prisma.product.findMany({
      where,
      include: {
        stockLogs: {
          select: { change: true, reason: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    const items = products.map(p => {
      let totalStocked = 0;
      let totalSold = 0;

      p.stockLogs.forEach(log => {
        if (log.change > 0) {
          totalStocked += log.change;
        } else if (log.reason === 'Sale' || log.reason === 'sale') {
          totalSold += Math.abs(log.change);
        }
      });

      const costPrice = parseFloat(p.costPrice) || 0;
      const sellingPrice = parseFloat(p.sellingPrice) || 0;
      const currentStock = p.stock;

      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        currentStock,
        totalStocked,
        totalSold,
        costPrice,
        sellingPrice,
        stockCostValue: currentStock * costPrice,
        stockSellValue: currentStock * sellingPrice,
        soldCostValue: totalSold * costPrice,
        soldSellValue: totalSold * sellingPrice,
        potentialProfit: currentStock * (sellingPrice - costPrice),
      };
    });

    // Summary totals
    const summary = {
      totalProducts: items.length,
      totalItemsInStock: items.reduce((sum, i) => sum + i.currentStock, 0),
      totalItemsStocked: items.reduce((sum, i) => sum + i.totalStocked, 0),
      totalItemsSold: items.reduce((sum, i) => sum + i.totalSold, 0),
      totalStockCostValue: items.reduce((sum, i) => sum + i.stockCostValue, 0),
      totalStockSellValue: items.reduce((sum, i) => sum + i.stockSellValue, 0),
      totalSoldCostValue: items.reduce((sum, i) => sum + i.soldCostValue, 0),
      totalSoldSellValue: items.reduce((sum, i) => sum + i.soldSellValue, 0),
      totalPotentialProfit: items.reduce((sum, i) => sum + i.potentialProfit, 0),
    };

    res.json({ items, summary });
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
