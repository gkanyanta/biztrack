const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const XLSX = require('xlsx');

router.use(authenticate);

router.get('/pnl', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter } });
    const expenses = await prisma.expense.findMany({ where: dateFilter });
    const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const cogs = sales.reduce((s, r) => s + (parseFloat(r.costPrice) * r.qty), 0);
    const shippingCost = sales.reduce((s, r) => s + parseFloat(r.shippingCost), 0);
    const shippingCharge = sales.reduce((s, r) => s + parseFloat(r.shippingCharge), 0);
    const discount = sales.reduce((s, r) => s + parseFloat(r.discount), 0);
    const grossProfit = revenue - cogs - shippingCost + shippingCharge - discount;
    const expensesByCategory = {}; let totalExpenses = 0;
    expenses.forEach(e => { const amt = parseFloat(e.amount); if (!expensesByCategory[e.category]) expensesByCategory[e.category] = 0; expensesByCategory[e.category] += amt; totalExpenses += amt; });
    const netProfit = grossProfit - totalExpenses;
    res.json({ revenue, cogs, shippingCost, shippingCharge, discount, grossProfit, expensesByCategory, totalExpenses, netProfit, profitMargin: cogs > 0 ? (netProfit / cogs) * 100 : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/sales', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to, productId, customerId, status } = req.query;
    const where = { companyId };
    if (status) where.status = status; if (productId) where.productId = productId; if (customerId) where.customerId = customerId;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where, include: { product: true, customer: true }, orderBy: { date: 'desc' } });
    const summary = { totalSales: sales.length, totalRevenue: sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0), totalProfit: sales.reduce((s, r) => s + parseFloat(r.totalPrice) - (parseFloat(r.costPrice) * r.qty) - parseFloat(r.shippingCost) + parseFloat(r.shippingCharge) - parseFloat(r.discount), 0) };
    res.json({ sales, summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/products', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { from, to } = req.query;
    const dateFilter = { companyId };
    if (from || to) { dateFilter.date = {}; if (from) dateFilter.date.gte = new Date(from); if (to) dateFilter.date.lte = new Date(to + 'T23:59:59.999Z'); }
    const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter }, include: { product: true } });
    const productMap = {};
    sales.forEach(s => { const pid = s.productId; if (!productMap[pid]) productMap[pid] = { id: pid, name: s.product.name, sku: s.product.sku, revenue: 0, qtySold: 0, profit: 0, orders: 0 }; productMap[pid].revenue += parseFloat(s.totalPrice); productMap[pid].qtySold += s.qty; productMap[pid].profit += parseFloat(s.totalPrice) - (parseFloat(s.costPrice) * s.qty); productMap[pid].orders += 1; });
    res.json(Object.values(productMap).sort((a, b) => b.revenue - a.revenue));
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      const sales = await prisma.sale.findMany({ where: dateFilter, include: { product: true }, orderBy: { date: 'desc' } });
      data = sales.map(s => ({ 'Order #': s.orderNumber, Date: s.date.toISOString().slice(0, 10), Product: s.product.name, Qty: s.qty, 'Unit Price': parseFloat(s.unitPrice), Total: parseFloat(s.totalPrice), Cost: parseFloat(s.costPrice) * s.qty, 'Shipping Cost': parseFloat(s.shippingCost), 'Shipping Charge': parseFloat(s.shippingCharge), Discount: parseFloat(s.discount), Status: s.status, Payment: s.paymentStatus, Customer: s.customerName || '', City: s.customerCity || '' }));
      filename = 'sales-report.csv';
    } else if (type === 'expenses') {
      const expenses = await prisma.expense.findMany({ where: dateFilter, orderBy: { date: 'desc' } });
      data = expenses.map(e => ({ Date: e.date.toISOString().slice(0, 10), Description: e.description, Amount: parseFloat(e.amount), Category: e.category, 'Payment Method': e.paymentMethod || '', Recurring: e.isRecurring ? 'Yes' : 'No', Notes: e.notes || '' }));
      filename = 'expenses-report.csv';
    } else if (type === 'pnl') {
      const sales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' }, ...dateFilter } });
      const expenses = await prisma.expense.findMany({ where: dateFilter });
      const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
      const cogs = sales.reduce((s, r) => s + (parseFloat(r.costPrice) * r.qty), 0);
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
    }
    if (data.length === 0) return res.status(200).send('No data');
    const headers = Object.keys(data[0]);
    const csv = [headers.join(','), ...data.map(row => headers.map(h => { const val = String(row[h] ?? ''); return val.includes(',') ? `"${val}"` : val; }).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
