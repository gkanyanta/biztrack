const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { authenticate, requireSuperadmin } = require('../middleware/auth');

router.use(authenticate);
router.use(requireSuperadmin);

// Platform stats overview
router.get('/stats', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const totalCompanies = await prisma.company.count();
    const activeCompanies = await prisma.company.count({ where: { isActive: true } });
    const totalUsers = await prisma.user.count({ where: { role: 'admin' } });
    const newestCompany = await prisma.company.findFirst({ orderBy: { createdAt: 'desc' } });

    // Platform-wide revenue
    const allSales = await prisma.sale.findMany({ where: { status: { not: 'Cancelled' } }, select: { totalPrice: true, costPrice: true, qty: true, companyId: true } });
    const totalRevenue = allSales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const totalCOGS = allSales.reduce((s, r) => s + (parseFloat(r.costPrice) * r.qty), 0);
    const totalOrders = allSales.length;

    // Per-company revenue for top companies
    const revenueByCompany = {};
    allSales.forEach(s => {
      if (!revenueByCompany[s.companyId]) revenueByCompany[s.companyId] = { revenue: 0, orders: 0 };
      revenueByCompany[s.companyId].revenue += parseFloat(s.totalPrice);
      revenueByCompany[s.companyId].orders += 1;
    });

    const companyIds = Object.keys(revenueByCompany);
    const companyNames = companyIds.length > 0
      ? await prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } })
      : [];
    const nameMap = {};
    companyNames.forEach(c => { nameMap[c.id] = c.name; });

    const topCompanies = Object.entries(revenueByCompany)
      .map(([id, data]) => ({ id, name: nameMap[id] || 'Unknown', ...data }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    res.json({ totalCompanies, activeCompanies, totalUsers, newestCompany, totalRevenue, totalCOGS, totalOrders, topCompanies });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// List all companies
router.get('/companies', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companies = await prisma.company.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { users: true, products: true, sales: true, customers: true } } },
    });
    res.json(companies);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Get company detail with users and metrics
router.get('/companies/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({
      where: { id: req.params.id },
      include: {
        users: { select: { id: true, username: true, name: true, role: true, createdAt: true } },
        _count: { select: { products: true, sales: true, customers: true, expenses: true } },
        settings: { select: { key: true, value: true } },
      },
    });
    if (!company) return res.status(404).json({ error: 'Company not found' });

    // Company revenue metrics
    const sales = await prisma.sale.findMany({ where: { companyId: req.params.id, status: { not: 'Cancelled' } }, select: { totalPrice: true, costPrice: true, qty: true } });
    const revenue = sales.reduce((s, r) => s + parseFloat(r.totalPrice), 0);
    const cogs = sales.reduce((s, r) => s + (parseFloat(r.costPrice) * r.qty), 0);
    const expenses = await prisma.expense.findMany({ where: { companyId: req.params.id }, select: { amount: true } });
    const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);

    const settingsObj = {};
    company.settings.forEach(s => { settingsObj[s.key] = s.value; });

    res.json({
      ...company,
      settings: settingsObj,
      metrics: { revenue, cogs, grossProfit: revenue - cogs, totalExpenses, netProfit: revenue - cogs - totalExpenses, totalOrders: sales.length },
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Create company + admin
router.post('/companies', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { companyName, username, password, name } = req.body;
    if (!companyName || !username || !password || !name) {
      return res.status(400).json({ error: 'Company name, username, password, and name are required' });
    }

    const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const existing = await prisma.company.findUnique({ where: { slug } });
    if (existing) return res.status(400).json({ error: 'A company with a similar name already exists' });

    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) return res.status(400).json({ error: 'Username already taken' });

    const company = await prisma.company.create({ data: { name: companyName, slug } });
    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, password: hashed, name, role: 'admin', companyId: company.id },
    });

    const defaults = [
      { key: 'currency', value: 'ZMW', companyId: company.id },
      { key: 'businessName', value: companyName, companyId: company.id },
      { key: 'currencySymbol', value: 'K', companyId: company.id },
    ];
    for (const s of defaults) {
      await prisma.setting.create({ data: s });
    }

    res.status(201).json({ company, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Edit company details
router.put('/companies/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name } = req.body;
    const data = {};
    if (name) data.name = name;
    const company = await prisma.company.update({ where: { id: req.params.id }, data });
    res.json(company);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Toggle company active status
router.put('/companies/:id/toggle-status', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { id: req.params.id } });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const updated = await prisma.company.update({ where: { id: req.params.id }, data: { isActive: !company.isActive } });
    res.json(updated);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Delete company and all data
router.delete('/companies/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.params.id;
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found' });

    // Delete in dependency order
    await prisma.debtReminder.deleteMany({ where: { companyId } });
    await prisma.creditPayment.deleteMany({ where: { companyId } });
    await prisma.orderStatusLog.deleteMany({ where: { companyId } });
    await prisma.stockLog.deleteMany({ where: { companyId } });
    await prisma.sale.deleteMany({ where: { companyId } });
    await prisma.product.deleteMany({ where: { companyId } });
    await prisma.customer.deleteMany({ where: { companyId } });
    await prisma.expense.deleteMany({ where: { companyId } });
    await prisma.shippingRate.deleteMany({ where: { companyId } });
    await prisma.setting.deleteMany({ where: { companyId } });
    await prisma.user.deleteMany({ where: { companyId } });
    await prisma.company.delete({ where: { id: companyId } });

    res.json({ message: `Company "${company.name}" and all data deleted` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Upload company logo (saves to settings)
router.put('/companies/:id/logo', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.params.id;
    const { logo } = req.body; // base64 data URL
    if (!logo && logo !== '') return res.status(400).json({ error: 'Logo data required' });

    await prisma.setting.upsert({
      where: { companyId_key: { companyId, key: 'companyLogo' } },
      update: { value: logo },
      create: { key: 'companyLogo', value: logo, companyId },
    });
    res.json({ message: 'Logo updated' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Add user to existing company
router.post('/companies/:id/users', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.params.id;
    const { username, password, name } = req.body;
    if (!username || !password || !name) {
      return res.status(400).json({ error: 'Username, password, and name are required' });
    }

    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) return res.status(400).json({ error: 'Username already taken' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, password: hashed, name, role: 'admin', companyId },
    });

    res.status(201).json({ id: user.id, username: user.username, name: user.name, role: user.role, createdAt: user.createdAt });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// Reset admin password
router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'superadmin') return res.status(403).json({ error: 'Cannot reset superadmin password from here' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: req.params.id }, data: { password: hashed } });
    res.json({ message: 'Password reset successfully' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
