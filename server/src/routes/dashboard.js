const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to } = req.query;

    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }

    const saleCOGS = (s) => s.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0);

    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { items: true } });
    const totalRevenue = sales.reduce((sum, s) => sum + parseFloat(s.totalPrice), 0);
    const totalCOGS = sales.reduce((sum, s) => sum + saleCOGS(s), 0);
    const totalShippingCost = sales.reduce((sum, s) => sum + parseFloat(s.shippingCost), 0);
    const totalShippingCharge = sales.reduce((sum, s) => sum + parseFloat(s.shippingCharge), 0);
    const totalDiscount = sales.reduce((sum, s) => sum + parseFloat(s.discount), 0);
    const grossProfit = totalRevenue - totalCOGS - totalShippingCost + totalShippingCharge - totalDiscount;

    const expenses = await prisma.expense.findMany({ where: dateFilter });
    const totalExpenses = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);
    const netProfit = grossProfit - totalExpenses;

    const adExpenses = expenses.filter(e => e.category === 'Facebook Ads');
    const adSpend = adExpenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);
    const roas = adSpend > 0 ? totalRevenue / adSpend : 0;
    const totalOrders = sales.length;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const profitMargin = totalCOGS > 0 ? (netProfit / totalCOGS) * 100 : 0;

    const monthlyData = {};
    sales.forEach(s => { const month = s.date.toISOString().slice(0, 7); if (!monthlyData[month]) monthlyData[month] = { revenue: 0, cogs: 0, expenses: 0, orders: 0 }; monthlyData[month].revenue += parseFloat(s.totalPrice); monthlyData[month].cogs += saleCOGS(s); monthlyData[month].orders += 1; });
    expenses.forEach(e => { const month = e.date.toISOString().slice(0, 7); if (!monthlyData[month]) monthlyData[month] = { revenue: 0, cogs: 0, expenses: 0, orders: 0 }; monthlyData[month].expenses += parseFloat(e.amount); });
    const monthlySummary = Object.entries(monthlyData).sort(([a], [b]) => a.localeCompare(b)).map(([month, data]) => ({ month, revenue: data.revenue, profit: data.revenue - data.cogs - data.expenses, expenses: data.expenses, orders: data.orders }));

    const expenseByCategory = {};
    expenses.forEach(e => { if (!expenseByCategory[e.category]) expenseByCategory[e.category] = 0; expenseByCategory[e.category] += parseFloat(e.amount); });

    const productSales = {};
    sales.forEach(s => { s.items.forEach(i => { if (!productSales[i.productId]) productSales[i.productId] = { revenue: 0, qty: 0 }; productSales[i.productId].revenue += parseFloat(i.totalPrice); productSales[i.productId].qty += i.qty; }); });
    const productIds = Object.keys(productSales);
    const products = productIds.length > 0 ? await prisma.product.findMany({ where: { id: { in: productIds }, companyId } }) : [];
    const topProducts = products.map(p => ({ name: p.name, revenue: productSales[p.id].revenue, qty: productSales[p.id].qty })).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    const lowStock = await prisma.product.findMany({ where: { isActive: true, companyId }, orderBy: { stock: 'asc' }, take: 20 });
    const lowStockProducts = lowStock.filter(p => p.stock <= p.reorderLevel);
    const pendingOrders = await prisma.sale.count({ where: { companyId, status: { in: ['Pending', 'Confirmed'] } } });

    // ---- GROWTH TRACKER ----
    const now = new Date();
    const thisMonthStart2 = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const lastMonthSales = await prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' }, date: { gte: lastMonthStart, lte: lastMonthEnd } }, include: { items: true } });
    const lastMonthRevenue = lastMonthSales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const lastMonthOrders = lastMonthSales.length;

    const currentMonthSales = sales.filter(s => new Date(s.date) >= thisMonthStart2);
    const thisMonthRevenue2 = currentMonthSales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const thisMonthOrders = currentMonthSales.length;
    const thisMonthCOGS2 = currentMonthSales.reduce((s, r) => s + saleCOGS(r), 0);

    const growthTarget = lastMonthRevenue * 3;
    const growthProgress = growthTarget > 0 ? (thisMonthRevenue2 / growthTarget) * 100 : 0;
    const remainingToTarget = Math.max(0, growthTarget - thisMonthRevenue2);
    const dayOfMonth2 = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeft = daysInMonth - dayOfMonth2;
    const dailyRevenueRate = dayOfMonth2 > 0 ? thisMonthRevenue2 / dayOfMonth2 : 0;
    const dailyTargetNeeded = daysLeft > 0 ? remainingToTarget / daysLeft : remainingToTarget;
    const projectedMonthRevenue = dailyRevenueRate * daysInMonth;
    const projectedMonthOrders = dayOfMonth2 > 0 ? Math.round((thisMonthOrders / dayOfMonth2) * daysInMonth) : 0;

    const avgProfitPerSale = thisMonthOrders > 0 ? (thisMonthRevenue2 - thisMonthCOGS2) / thisMonthOrders : 0;
    const currentRoas = adSpend > 0 ? totalRevenue / adSpend : 2;
    const monthlyAdBudget = growthTarget > 0 ? growthTarget / Math.max(currentRoas, 1) : 0;
    const avgCostPerItem = thisMonthOrders > 0 ? thisMonthCOGS2 / thisMonthOrders : 0;
    const monthlyInventory = avgCostPerItem * thisMonthOrders * 3;
    const totalMonthlyReinvestment = monthlyAdBudget + monthlyInventory;
    const reinvestmentPerSale = thisMonthOrders > 0 ? totalMonthlyReinvestment / (thisMonthOrders * 3) : 0;
    const percentOfProfit = avgProfitPerSale > 0 ? (reinvestmentPerSale / avgProfitPerSale) * 100 : 0;

    const growth = {
      thisMonthRevenue: thisMonthRevenue2, thisMonthOrders, lastMonthRevenue, lastMonthOrders,
      growthTarget, growthProgress: Math.min(growthProgress, 100), remainingToTarget, dailyTargetNeeded, daysLeft,
      dailyRevenueRate, projectedMonthRevenue, projectedMonthOrders,
      reinvestment: {
        perSale: reinvestmentPerSale, avgProfitPerSale, percentOfProfit, roas: currentRoas,
        monthlyAdBudget, monthlyInventory, totalMonthly: totalMonthlyReinvestment,
      },
    };

    // ---- DAILY SAVINGS (25% of daily gross profit) ----
    const SAVINGS_RATE = 0.25;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const todaySales = await prisma.sale.findMany({ where: { companyId, status: { not: 'Cancelled' }, date: { gte: todayStart, lte: todayEnd } }, include: { items: true } });
    const todayRevenue = todaySales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const todayCOGS = todaySales.reduce((s, r) => s + saleCOGS(r), 0);
    const todayShippingCost = todaySales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    const todayGrossProfit = todayRevenue - todayCOGS - todayShippingCost;
    const todaySavings = Math.max(0, todayGrossProfit * SAVINGS_RATE);
    const todayReinvest = Math.max(0, todayGrossProfit - todaySavings);

    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthSales = sales.filter(s => new Date(s.date) >= thisMonthStart);
    const thisMonthRevenue = thisMonthSales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const thisMonthCOGS = thisMonthSales.reduce((s, r) => s + saleCOGS(r), 0);
    const thisMonthShippingCost = thisMonthSales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    const thisMonthGrossProfit = thisMonthRevenue - thisMonthCOGS - thisMonthShippingCost;
    const thisMonthSavingsTotal = Math.max(0, thisMonthGrossProfit * SAVINGS_RATE);
    const dayOfMonth = now.getDate();

    const savings = {
      rate: SAVINGS_RATE,
      today: { revenue: todayRevenue, grossProfit: todayGrossProfit, savings: todaySavings, reinvest: todayReinvest, orders: todaySales.length },
      thisMonth: { grossProfit: thisMonthGrossProfit, totalSavings: thisMonthSavingsTotal, totalReinvest: Math.max(0, thisMonthGrossProfit - thisMonthSavingsTotal), daysWithSales: [...new Set(thisMonthSales.map(s => s.date.toISOString().slice(0, 10)))].length },
      avgDailySavings: dayOfMonth > 0 ? thisMonthSavingsTotal / dayOfMonth : 0
    };

    res.json({ totalRevenue, totalCOGS, grossProfit, totalExpenses, netProfit, totalOrders, avgOrderValue, adSpend, roas, profitMargin, monthlySummary, expenseByCategory, topProducts, lowStockProducts, pendingOrders, growth, savings });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
