const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');

router.use(authenticate);

// Consultant self-dashboard — their sales, commission earned, balance
router.get('/consultant', async (req, res) => {
  try {
    if (req.user.role !== 'consultant') return res.status(403).json({ error: 'Consultant access required' });
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const consultantId = req.user.consultantId;
    const consultant = await prisma.consultant.findFirst({ where: { id: consultantId, companyId } });
    if (!consultant) return res.status(404).json({ error: 'Consultant not found' });

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const allSales = await prisma.sale.findMany({ where: { consultantId, companyId, status: { not: 'Cancelled' } }, include: { items: true }, orderBy: { date: 'desc' } });
    const monthSales = allSales.filter(s => new Date(s.date) >= monthStart);
    const todaySales = allSales.filter(s => new Date(s.date) >= todayStart && new Date(s.date) <= todayEnd);

    const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);
    const productsSoldInMonth = sum(monthSales, s => s.items.reduce((q, i) => q + i.qty, 0));

    const base = parseFloat(consultant.commissionRate);
    const tier = parseFloat(consultant.tierRate);
    const threshold = parseInt(consultant.tierThreshold) || 50;
    const calcComm = (n) => n <= threshold ? n * base : (threshold * base) + ((n - threshold) * tier);
    const commissionEarnedMonth = calcComm(productsSoldInMonth);

    const payments = await prisma.commissionPayment.findMany({ where: { consultantId, companyId }, orderBy: { createdAt: 'desc' } });
    const totalProductsSoldAllTime = sum(allSales, s => s.items.reduce((q, i) => q + i.qty, 0));
    const commissionEarnedAllTime = calcComm(totalProductsSoldAllTime);
    const commissionPaid = sum(payments.filter(p => p.type === 'commission'), p => parseFloat(p.amount));
    const allowancePaid = sum(payments.filter(p => p.type === 'allowance'), p => parseFloat(p.amount));
    const balance = commissionEarnedAllTime - commissionPaid;

    res.json({
      consultant: { id: consultant.id, name: consultant.name, commissionRate: consultant.commissionRate, tierThreshold: consultant.tierThreshold, tierRate: consultant.tierRate, monthlyAllowance: consultant.monthlyAllowance },
      today: { ordersCount: todaySales.length, productsSold: sum(todaySales, s => s.items.reduce((q, i) => q + i.qty, 0)), revenue: sum(todaySales, s => parseFloat(s.totalPrice)) },
      thisMonth: { ordersCount: monthSales.length, productsSold: productsSoldInMonth, revenue: sum(monthSales, s => parseFloat(s.totalPrice)), commissionEarned: commissionEarnedMonth },
      allTime: { ordersCount: allSales.length, productsSold: totalProductsSoldAllTime, commissionEarned: commissionEarnedAllTime, commissionPaid, allowancePaid, balance },
      recentSales: allSales.slice(0, 10).map(s => ({ id: s.id, orderNumber: s.orderNumber, date: s.date, customerName: s.customerName, totalPrice: s.totalPrice, status: s.status, paymentStatus: s.paymentStatus, productsCount: s.items.reduce((q, i) => q + i.qty, 0) })),
      recentPayments: payments.slice(0, 10),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/', requireAdmin, async (req, res) => {
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

    // ---- CONSULTANT IMPACT ----
    const calcComm = (total, rate, threshold, tierRate) => { const b = parseFloat(rate); const t = parseFloat(tierRate); const th = parseInt(threshold) || 50; if (total <= th) return total * b; return (th * b) + ((total - th) * t); };
    const consultants2 = await prisma.consultant.findMany({ where: { companyId } });
    let consultantImpact = null;
    if (consultants2.length > 0) {
      const consultantSales2 = currentMonthSales.filter(s => s.consultantId);
      const directSales2 = currentMonthSales.filter(s => !s.consultantId);
      const consultantRevenue2 = consultantSales2.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
      const directRevenue2 = directSales2.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
      const consultantCOGS2 = consultantSales2.reduce((s, r) => s + saleCOGS(r), 0);
      const consultantGrossProfit2 = consultantRevenue2 - consultantCOGS2;
      const commPayments = await prisma.commissionPayment.findMany({ where: { companyId } });
      const byConsultant = consultants2.map(c => {
        const cSales = consultantSales2.filter(s => s.consultantId === c.id);
        const cTotal = cSales.length;
        const cProdSold = cSales.reduce((s, r) => s + r.items.reduce((q, i) => q + i.qty, 0), 0);
        const cRev = cSales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
        const cCOGS = cSales.reduce((s, r) => s + saleCOGS(r), 0);
        const cGP = cRev - cCOGS;
        const cComm = calcComm(cProdSold, c.commissionRate, c.tierThreshold, c.tierRate);
        const cPaid = commPayments.filter(p => p.consultantId === c.id && p.type === 'commission').reduce((s, p) => s + parseFloat(p.amount), 0);
        const cAllPaid = commPayments.filter(p => p.consultantId === c.id && p.type === 'allowance').reduce((s, p) => s + parseFloat(p.amount), 0);
        return { id: c.id, name: c.name, isActive: c.isActive, totalSales: cTotal, productsSold: cProdSold, revenue: cRev, grossProfit: cGP, commissionEarned: cComm, commissionPaid: cPaid, allowancePaid: cAllPaid, netProfit: cGP - cComm, avgOrderValue: cTotal > 0 ? cRev / cTotal : 0, balance: cComm - cPaid };
      });
      const totalCommEarned = byConsultant.reduce((s, c) => s + c.commissionEarned, 0);
      consultantImpact = {
        totalConsultants: consultants2.filter(c => c.isActive).length,
        consultantSalesCount: consultantSales2.length, directSalesCount: directSales2.length,
        consultantRevenue: consultantRevenue2, directRevenue: directRevenue2,
        consultantGrossProfit: consultantGrossProfit2, totalCommissionEarned: totalCommEarned,
        totalCommissionCost: totalCommEarned + consultants2.reduce((s, c) => s + parseFloat(c.monthlyAllowance), 0),
        netProfitAfterCommission: consultantGrossProfit2 - totalCommEarned,
        consultantSharePercent: thisMonthOrders > 0 ? (consultantSales2.length / thisMonthOrders) * 100 : 0,
        revenueSharePercent: thisMonthRevenue > 0 ? (consultantRevenue2 / thisMonthRevenue) * 100 : 0,
        byConsultant,
      };
    }

    res.json({ totalRevenue, totalCOGS, grossProfit, totalExpenses, netProfit, totalOrders, avgOrderValue, adSpend, roas, profitMargin, monthlySummary, expenseByCategory, topProducts, lowStockProducts, pendingOrders, growth, savings, consultantImpact });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
