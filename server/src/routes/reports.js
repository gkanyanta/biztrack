const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const XLSX = require('xlsx');

router.use(authenticate);
router.use(requireAdmin);

router.get('/pnl', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { items: true } });
    const expenses = await prisma.expense.findMany({ where: dateFilter });
    const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const cogs = sales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);
    const shippingCost = sales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    const shippingCharge = sales.reduce((s, r) => s + parseFloat(r.shippingCharge), 0);
    const discount = sales.reduce((s, r) => s + parseFloat(r.discount), 0);
    const grossProfit = revenue - cogs - shippingCost + shippingCharge - discount;
    const expensesByCategory = {}; let totalExpenses = 0;
    expenses.forEach(e => { const amt = parseFloat(e.amount); if (!expensesByCategory[e.category]) expensesByCategory[e.category] = 0; expensesByCategory[e.category] += amt; totalExpenses += amt; });
    const netProfit = grossProfit - totalExpenses;
    res.json({ revenue, cogs, shippingCost, shippingCharge, discount, grossProfit, expensesByCategory, totalExpenses, netProfit, profitMargin: cogs > 0 ? (netProfit / cogs) * 100 : 0 });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/sales', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to, productId, customerId, status } = req.query;
    const where = { companyId };
    if (status) where.status = status;
    if (productId) where.items = { some: { productId } };
    if (customerId) where.customerId = customerId;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where, include: { items: { include: { product: true } }, customer: true }, orderBy: { date: 'desc' } });
    const summary = {
      totalSales: sales.length,
      totalRevenue: sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0),
      totalProfit: sales.reduce((s, r) => s + parseFloat(r.totalPrice) - r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0) - parseFloat(r.shippingCost) + parseFloat(r.shippingCharge) - parseFloat(r.discount), 0)
    };
    res.json({ sales, summary });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/expenses', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to, category } = req.query;
    const where = { companyId };
    if (category) where.category = category;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const expenses = await prisma.expense.findMany({ where, orderBy: { date: 'desc' } });
    const byCategory = {}; let total = 0;
    expenses.forEach(e => { const amt = parseFloat(e.amount); if (!byCategory[e.category]) byCategory[e.category] = 0; byCategory[e.category] += amt; total += amt; });
    res.json({ expenses, byCategory, total });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/products', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { items: { include: { product: true } } } });
    const productMap = {};
    sales.forEach(s => {
      s.items.forEach(item => {
        const pid = item.productId;
        if (!productMap[pid]) productMap[pid] = { id: pid, name: item.product.name, sku: item.product.sku, revenue: 0, qtySold: 0, profit: 0, orders: 0 };
        const itemRevenue = parseFloat(item.totalPrice);
        const itemCost = parseFloat(item.costPrice) * item.qty;
        productMap[pid].revenue += itemRevenue;
        productMap[pid].qtySold += item.qty;
        productMap[pid].profit += itemRevenue - itemCost;
        productMap[pid].orders += 1;
      });
    });
    res.json(Object.values(productMap).sort((a, b) => b.revenue - a.revenue));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/customers', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, customerId: { not: null }, ...dateFilter }, include: { customer: true } });
    const customerMap = {};
    sales.forEach(s => { const cid = s.customerId; if (!cid) return; if (!customerMap[cid]) customerMap[cid] = { id: cid, name: s.customer?.name || s.customerName, phone: s.customer?.phone || s.customerPhone, city: s.customer?.city || s.customerCity, totalSpent: 0, orderCount: 0 }; customerMap[cid].totalSpent += parseFloat(s.totalPrice); customerMap[cid].orderCount += 1; });
    res.json(Object.values(customerMap).sort((a, b) => b.totalSpent - a.totalSpent));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/credit', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const now = new Date();

    const creditSales = await prisma.sale.findMany({
      where: { companyId, paymentType: 'Credit', paymentStatus: { not: 'Paid' } },
      include: { customer: true, creditPayments: { orderBy: { createdAt: 'desc' } } }
    });

    const allCreditSales = await prisma.sale.findMany({
      where: { companyId, paymentType: 'Credit' },
      include: { creditPayments: true }
    });

    // Aging buckets
    const aging = { current: 0, days30: 0, days60: 0, days90: 0, days90plus: 0 };
    const agingDetails = [];

    creditSales.forEach(s => {
      const balance = parseFloat(s.totalPrice) - parseFloat(s.amountPaid);
      if (balance <= 0) return;
      const dueDate = s.creditDueDate ? new Date(s.creditDueDate) : new Date(s.createdAt);
      const daysOverdue = Math.max(0, Math.floor((now - dueDate) / (1000 * 60 * 60 * 24)));

      let bucket;
      if (daysOverdue <= 0) { aging.current += balance; bucket = 'Current'; }
      else if (daysOverdue <= 30) { aging.days30 += balance; bucket = '1-30 days'; }
      else if (daysOverdue <= 60) { aging.days60 += balance; bucket = '31-60 days'; }
      else if (daysOverdue <= 90) { aging.days90 += balance; bucket = '61-90 days'; }
      else { aging.days90plus += balance; bucket = '90+ days'; }

      agingDetails.push({
        id: s.id, orderNumber: s.orderNumber,
        customerName: s.customerName || s.customer?.name || 'Unknown',
        customerPhone: s.customerPhone || s.customer?.phone || '',
        totalPrice: parseFloat(s.totalPrice), amountPaid: parseFloat(s.amountPaid),
        balance, dueDate: s.creditDueDate, daysOverdue, bucket,
        lastPayment: s.creditPayments[0]?.createdAt || null
      });
    });

    // Collection rate
    const totalCreditIssued = allCreditSales.reduce((sum, s) => sum + parseFloat(s.totalPrice), 0);
    const totalCollected = allCreditSales.reduce((sum, s) => sum + parseFloat(s.amountPaid), 0);
    const collectionRate = totalCreditIssued > 0 ? (totalCollected / totalCreditIssued) * 100 : 0;

    // Payment trends - last 6 months
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const recentPayments = await prisma.creditPayment.findMany({
      where: { companyId, createdAt: { gte: sixMonthsAgo } },
      orderBy: { createdAt: 'asc' }
    });

    const monthlyCollections = {};
    recentPayments.forEach(p => {
      const month = p.createdAt.toISOString().slice(0, 7);
      if (!monthlyCollections[month]) monthlyCollections[month] = 0;
      monthlyCollections[month] += parseFloat(p.amount);
    });
    const paymentTrends = Object.entries(monthlyCollections).map(([month, amount]) => ({ month, amount }));

    const totalOutstanding = aging.current + aging.days30 + aging.days60 + aging.days90 + aging.days90plus;
    const overdueTotal = aging.days30 + aging.days60 + aging.days90 + aging.days90plus;

    res.json({
      totalOutstanding, overdueTotal, totalCreditIssued, totalCollected, collectionRate,
      aging, agingDetails: agingDetails.sort((a, b) => b.balance - a.balance),
      paymentTrends, totalDebtors: creditSales.length
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/inventory', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const now = new Date();

    const products = await prisma.product.findMany({
      where: { companyId, isActive: true },
      include: { saleItems: { include: { sale: { select: { date: true, status: true } } } } }
    });

    let totalStockValue = 0, totalPotentialRevenue = 0, totalPotentialProfit = 0;
    const productDetails = [];

    products.forEach(p => {
      const costPrice = parseFloat(p.costPrice);
      const sellingPrice = parseFloat(p.sellingPrice);
      const stockValue = p.stock * costPrice;
      const potentialRevenue = p.stock * sellingPrice;
      const potentialProfit = potentialRevenue - stockValue;

      totalStockValue += stockValue;
      totalPotentialRevenue += potentialRevenue;
      totalPotentialProfit += potentialProfit;

      // Calculate turnover - units sold in last 90 days
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const recentSales = p.saleItems.filter(si =>
        si.sale.status !== 'Cancelled' && new Date(si.sale.date) >= ninetyDaysAgo
      );
      const unitsSold90d = recentSales.reduce((sum, si) => sum + si.qty, 0);

      // Last sold date
      const allSoldDates = p.saleItems
        .filter(si => si.sale.status !== 'Cancelled')
        .map(si => new Date(si.sale.date));
      const lastSoldDate = allSoldDates.length > 0 ? new Date(Math.max(...allSoldDates)) : null;

      // Days since last sale
      const daysSinceLastSale = lastSoldDate ? Math.floor((now - lastSoldDate) / (1000 * 60 * 60 * 24)) : null;

      // Total units ever sold
      const totalUnitsSold = p.saleItems
        .filter(si => si.sale.status !== 'Cancelled')
        .reduce((sum, si) => sum + si.qty, 0);

      // Turnover rate (annualized from 90-day window)
      const avgStock = p.stock > 0 ? p.stock : 1;
      const turnoverRate = (unitsSold90d / avgStock) * 4; // annualized

      // Dead stock flag: in stock but not sold in 90+ days
      const isDeadStock = p.stock > 0 && (daysSinceLastSale === null || daysSinceLastSale > 90);

      // Low stock flag
      const isLowStock = p.stock <= p.reorderLevel;

      const margin = costPrice > 0 ? ((sellingPrice - costPrice) / costPrice) * 100 : 0;

      productDetails.push({
        id: p.id, name: p.name, sku: p.sku, category: p.category,
        stock: p.stock, reorderLevel: p.reorderLevel,
        costPrice, sellingPrice, margin,
        stockValue, potentialRevenue, potentialProfit,
        unitsSold90d, totalUnitsSold, turnoverRate,
        lastSoldDate, daysSinceLastSale,
        isDeadStock, isLowStock
      });
    });

    const deadStockItems = productDetails.filter(p => p.isDeadStock);
    const lowStockItems = productDetails.filter(p => p.isLowStock);
    const deadStockValue = deadStockItems.reduce((sum, p) => sum + p.stockValue, 0);

    // Category breakdown
    const categoryBreakdown = {};
    productDetails.forEach(p => {
      const cat = p.category || 'Uncategorized';
      if (!categoryBreakdown[cat]) categoryBreakdown[cat] = { stockValue: 0, potentialRevenue: 0, itemCount: 0, totalStock: 0 };
      categoryBreakdown[cat].stockValue += p.stockValue;
      categoryBreakdown[cat].potentialRevenue += p.potentialRevenue;
      categoryBreakdown[cat].itemCount += 1;
      categoryBreakdown[cat].totalStock += p.stock;
    });

    res.json({
      summary: {
        totalProducts: products.length,
        totalStockValue, totalPotentialRevenue, totalPotentialProfit,
        deadStockCount: deadStockItems.length, deadStockValue,
        lowStockCount: lowStockItems.length
      },
      products: productDetails.sort((a, b) => b.stockValue - a.stockValue),
      categoryBreakdown: Object.entries(categoryBreakdown).map(([name, data]) => ({ name, ...data }))
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/export/csv', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { type, from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    let data = []; let filename = 'export.csv';
    if (type === 'sales') {
      const sales = await prisma.sale.findMany({ where: dateFilter, include: { items: { include: { product: true } }, customer: true }, orderBy: { date: 'desc' } });
      sales.forEach(s => {
        s.items.forEach(item => {
          data.push({
            'Order #': s.orderNumber,
            Date: s.date.toISOString().slice(0, 10),
            Product: item.product.name,
            Qty: item.qty,
            'Unit Price': parseFloat(item.unitPrice),
            'Item Total': parseFloat(item.totalPrice),
            'Cost Price': parseFloat(item.costPrice),
            'Item Cost': parseFloat(item.costPrice) * item.qty,
            'Sale Total': parseFloat(s.totalPrice),
            'Shipping Cost': parseFloat(s.shippingCost),
            'Shipping Charge': parseFloat(s.shippingCharge),
            Discount: parseFloat(s.discount),
            Status: s.status,
            Payment: s.paymentStatus,
            Customer: s.customerName || '',
            City: s.customerCity || ''
          });
        });
      });
      filename = 'sales-report.csv';
    } else if (type === 'expenses') {
      const expenses = await prisma.expense.findMany({ where: dateFilter, orderBy: { date: 'desc' } });
      data = expenses.map(e => ({ Date: e.date.toISOString().slice(0, 10), Description: e.description, Amount: parseFloat(e.amount), Category: e.category, 'Payment Method': e.paymentMethod || '', Recurring: e.isRecurring ? 'Yes' : 'No', Notes: e.notes || '' }));
      filename = 'expenses-report.csv';
    } else if (type === 'pnl') {
      const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { items: true } });
      const expenses = await prisma.expense.findMany({ where: dateFilter });
      const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
      const cogs = sales.reduce((s, r) => s + r.items.reduce((sum, i) => sum + (parseFloat(i.costPrice) * i.qty), 0), 0);
      const shippingCost = sales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
      const grossProfit = revenue - cogs - shippingCost;
      const expensesByCategory = {}; let totalExpenses = 0;
      expenses.forEach(e => { const amt = parseFloat(e.amount); if (!expensesByCategory[e.category]) expensesByCategory[e.category] = 0; expensesByCategory[e.category] += amt; totalExpenses += amt; });
      const pnlData = [{ Item: 'Revenue', Amount: revenue }, { Item: 'Cost of Goods Sold', Amount: -cogs }, { Item: 'Shipping Costs', Amount: -shippingCost }, { Item: 'Gross Profit', Amount: grossProfit }, { Item: '', Amount: '' }, { Item: 'EXPENSES', Amount: '' }, ...Object.entries(expensesByCategory).map(([cat, amt]) => ({ Item: cat, Amount: -amt })), { Item: 'Total Expenses', Amount: -totalExpenses }, { Item: '', Amount: '' }, { Item: 'Net Profit', Amount: grossProfit - totalExpenses }];
      const wb = XLSX.utils.book_new(); const ws = XLSX.utils.json_to_sheet(pnlData); XLSX.utils.book_append_sheet(wb, ws, 'P&L Statement');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=pnl-statement.xlsx');
      return res.send(buf);
    } else if (type === 'credit') {
      const creditSales = await prisma.sale.findMany({ where: { companyId, paymentType: 'Credit', paymentStatus: { not: 'Paid' } }, include: { customer: true } });
      const now = new Date();
      creditSales.forEach(s => {
        const balance = parseFloat(s.totalPrice) - parseFloat(s.amountPaid);
        if (balance <= 0) return;
        const dueDate = s.creditDueDate ? new Date(s.creditDueDate) : new Date(s.createdAt);
        const daysOverdue = Math.max(0, Math.floor((now - dueDate) / (1000 * 60 * 60 * 24)));
        let bucket = 'Current';
        if (daysOverdue > 90) bucket = '90+ days';
        else if (daysOverdue > 60) bucket = '61-90 days';
        else if (daysOverdue > 30) bucket = '31-60 days';
        else if (daysOverdue > 0) bucket = '1-30 days';
        data.push({ 'Order #': s.orderNumber, Customer: s.customerName || s.customer?.name || '', Phone: s.customerPhone || s.customer?.phone || '', Total: parseFloat(s.totalPrice), Paid: parseFloat(s.amountPaid), Balance: balance, 'Due Date': s.creditDueDate ? s.creditDueDate.toISOString().slice(0, 10) : '', 'Days Overdue': daysOverdue, Bucket: bucket });
      });
      filename = 'credit-report.csv';
    } else if (type === 'inventory') {
      const products = await prisma.product.findMany({ where: { companyId, isActive: true }, include: { saleItems: { include: { sale: { select: { date: true, status: true } } } } } });
      const now = new Date(); const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      products.forEach(p => {
        const costPrice = parseFloat(p.costPrice); const sellingPrice = parseFloat(p.sellingPrice);
        const unitsSold90d = p.saleItems.filter(si => si.sale.status !== 'Cancelled' && new Date(si.sale.date) >= ninetyDaysAgo).reduce((sum, si) => sum + si.qty, 0);
        const allSoldDates = p.saleItems.filter(si => si.sale.status !== 'Cancelled').map(si => new Date(si.sale.date));
        const lastSoldDate = allSoldDates.length > 0 ? new Date(Math.max(...allSoldDates)) : null;
        const daysSinceLastSale = lastSoldDate ? Math.floor((now - lastSoldDate) / (1000 * 60 * 60 * 24)) : null;
        const isDeadStock = p.stock > 0 && (daysSinceLastSale === null || daysSinceLastSale > 90);
        const margin = costPrice > 0 ? ((sellingPrice - costPrice) / costPrice) * 100 : 0;
        data.push({ Product: p.name, SKU: p.sku, Category: p.category || '', Stock: p.stock, 'Cost Price': costPrice, 'Selling Price': sellingPrice, 'Stock Value': p.stock * costPrice, 'Potential Revenue': p.stock * sellingPrice, 'Margin %': margin.toFixed(1), 'Sold (90d)': unitsSold90d, 'Last Sold': lastSoldDate ? lastSoldDate.toISOString().slice(0, 10) : 'Never', Status: isDeadStock ? 'Dead Stock' : p.stock <= p.reorderLevel ? 'Low Stock' : 'OK' });
      });
      filename = 'inventory-report.csv';
    }
    if (data.length === 0) return res.status(200).send('No data');
    const headers = Object.keys(data[0]);
    const csv = [headers.join(','), ...data.map(row => headers.map(h => { const val = String(row[h] ?? ''); return val.includes(',') ? `"${val}"` : val; }).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(csv);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
