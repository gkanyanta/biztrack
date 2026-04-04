const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { from, to } = req.query;

    const dateFilter = {};
    if (from || to) {
      dateFilter.date = {};
      if (from) dateFilter.date.gte = new Date(from);
      if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z');
    }

    // Sales data (non-cancelled)
    const sales = await prisma.sale.findMany({
      where: { status: { not: 'Cancelled' }, ...dateFilter }
    });

    const totalRevenue = sales.reduce((sum, s) => sum + parseFloat(s.totalPrice), 0);
    const totalCOGS = sales.reduce((sum, s) => sum + (parseFloat(s.costPrice) * s.qty), 0);
    const totalShippingCost = sales.reduce((sum, s) => sum + parseFloat(s.shippingCost), 0);
    const totalShippingCharge = sales.reduce((sum, s) => sum + parseFloat(s.shippingCharge), 0);
    const totalDiscount = sales.reduce((sum, s) => sum + parseFloat(s.discount), 0);
    const grossProfit = totalRevenue - totalCOGS - totalShippingCost + totalShippingCharge - totalDiscount;

    // Expenses
    const expenses = await prisma.expense.findMany({ where: dateFilter });
    const totalExpenses = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);
    const netProfit = grossProfit - totalExpenses;

    // Ad spend (Facebook Ads category)
    const adExpenses = expenses.filter(e => e.category === 'Facebook Ads');
    const adSpend = adExpenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);
    const roas = adSpend > 0 ? totalRevenue / adSpend : 0;

    // Order counts
    const totalOrders = sales.length;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const profitMargin = totalCOGS > 0 ? (netProfit / totalCOGS) * 100 : 0;

    // Monthly data for charts
    const monthlyData = {};
    sales.forEach(s => {
      const month = s.date.toISOString().slice(0, 7);
      if (!monthlyData[month]) monthlyData[month] = { revenue: 0, cogs: 0, expenses: 0, orders: 0 };
      monthlyData[month].revenue += parseFloat(s.totalPrice);
      monthlyData[month].cogs += parseFloat(s.costPrice) * s.qty;
      monthlyData[month].orders += 1;
    });
    expenses.forEach(e => {
      const month = e.date.toISOString().slice(0, 7);
      if (!monthlyData[month]) monthlyData[month] = { revenue: 0, cogs: 0, expenses: 0, orders: 0 };
      monthlyData[month].expenses += parseFloat(e.amount);
    });

    const monthlySummary = Object.entries(monthlyData)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({
        month,
        revenue: data.revenue,
        profit: data.revenue - data.cogs - data.expenses,
        expenses: data.expenses,
        orders: data.orders
      }));

    // Expense breakdown by category
    const expenseByCategory = {};
    expenses.forEach(e => {
      if (!expenseByCategory[e.category]) expenseByCategory[e.category] = 0;
      expenseByCategory[e.category] += parseFloat(e.amount);
    });

    // Top products
    const productSales = {};
    sales.forEach(s => {
      if (!productSales[s.productId]) productSales[s.productId] = { revenue: 0, qty: 0 };
      productSales[s.productId].revenue += parseFloat(s.totalPrice);
      productSales[s.productId].qty += s.qty;
    });

    const productIds = Object.keys(productSales);
    const products = productIds.length > 0
      ? await prisma.product.findMany({ where: { id: { in: productIds } } })
      : [];

    const topProducts = products
      .map(p => ({
        name: p.name,
        revenue: productSales[p.id].revenue,
        qty: productSales[p.id].qty
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    // Low stock products
    const lowStock = await prisma.product.findMany({
      where: { isActive: true },
      orderBy: { stock: 'asc' },
      take: 20
    });
    const lowStockProducts = lowStock.filter(p => p.stock <= p.reorderLevel);

    // Pending orders
    const pendingOrders = await prisma.sale.count({
      where: { status: { in: ['Pending', 'Confirmed'] } }
    });

    // ---- DAILY SAVINGS (25% of daily gross profit) ----
    const now = new Date();
    const SAVINGS_RATE = 0.25;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const todaySales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, date: { gte: todayStart, lte: todayEnd } } });
    const todayRevenue = todaySales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const todayCOGS = todaySales.reduce((s, r) => s + (parseFloat(r.costPrice) * r.qty), 0);
    const todayShippingCost = todaySales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    const todayGrossProfit = todayRevenue - todayCOGS - todayShippingCost;
    const todaySavings = Math.max(0, todayGrossProfit * SAVINGS_RATE);
    const todayReinvest = Math.max(0, todayGrossProfit - todaySavings);

    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthSales = sales.filter(s => new Date(s.date) >= thisMonthStart);
    const thisMonthRevenue = thisMonthSales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const thisMonthCOGS = thisMonthSales.reduce((s, r) => s + (parseFloat(r.costPrice) * r.qty), 0);
    const thisMonthShippingCost = thisMonthSales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    const thisMonthGrossProfit = thisMonthRevenue - thisMonthCOGS - thisMonthShippingCost;
    const thisMonthSavingsTotal = Math.max(0, thisMonthGrossProfit * SAVINGS_RATE);
    const dayOfMonth = now.getDate();

    const savings = {
      rate: SAVINGS_RATE,
      today: {
        revenue: todayRevenue,
        grossProfit: todayGrossProfit,
        savings: todaySavings,
        reinvest: todayReinvest,
        orders: todaySales.length
      },
      thisMonth: {
        grossProfit: thisMonthGrossProfit,
        totalSavings: thisMonthSavingsTotal,
        totalReinvest: Math.max(0, thisMonthGrossProfit - thisMonthSavingsTotal),
        daysWithSales: [...new Set(thisMonthSales.map(s => s.date.toISOString().slice(0, 10)))].length
      },
      avgDailySavings: dayOfMonth > 0 ? thisMonthSavingsTotal / dayOfMonth : 0
    };

    res.json({
      totalRevenue,
      totalCOGS,
      grossProfit,
      totalExpenses,
      netProfit,
      totalOrders,
      avgOrderValue,
      adSpend,
      roas,
      profitMargin,
      monthlySummary,
      expenseByCategory,
      topProducts,
      lowStockProducts,
      pendingOrders,
      savings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
