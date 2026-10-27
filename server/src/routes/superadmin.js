const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { authenticate, requireSuperadmin } = require('../middleware/auth');
const { zra_configProblems, zra_post, ZRA_TAX_CATEGORIES } = require('../utils/zra');

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
    const expenses = await prisma.expense.findMany({ where: { companyId: req.params.id, category: { not: 'Stock Purchase' } }, select: { amount: true } });
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
    await prisma.fiscalDocument.deleteMany({ where: { companyId } });
    await prisma.zraConfig.deleteMany({ where: { companyId } });
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

// ---- ZRA Smart Invoice, per company ----
// Only the superadmin switches it on and says where the company's VSDC is: that address is
// where BizTrack's server sends requests, so it is not something a company admin may change.

const ZRA_DEFAULTS = { enabled: false, environment: 'sandbox', vsdcUrl: null, tpin: null, branchId: '000', deviceSerial: null, defaultTaxCategory: null, startDate: null, qtyUnitCode: 'U', pkgUnitCode: 'NT', originCountry: null, deliveryClassCode: null, refundReasonCode: null, initialisedAt: null };

function zraView(config) {
  const c = config || ZRA_DEFAULTS;
  const { id, companyId, createdAt, updatedAt, deliveryRegisteredAt, ...rest } = c;
  return { ...ZRA_DEFAULTS, ...rest, problems: zra_configProblems(config ? c : null), allowedHosts: (process.env.ZRA_ALLOWED_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean) };
}

router.get('/companies/:id/zra', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    res.json(zraView(await prisma.zraConfig.findUnique({ where: { companyId: company.id } })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/companies/:id/zra', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const existing = await prisma.zraConfig.findUnique({ where: { companyId: company.id } });
    const b = req.body || {};
    const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const data = {};
    if (b.environment !== undefined) {
      if (!['sandbox', 'production'].includes(b.environment)) return res.status(400).json({ error: 'Environment must be sandbox or production' });
      data.environment = b.environment;
    }
    if (b.vsdcUrl !== undefined) data.vsdcUrl = text(b.vsdcUrl, 300);
    if (b.tpin !== undefined) {
      data.tpin = text(b.tpin, 10);
      if (data.tpin && !/^\d{10}$/.test(data.tpin)) return res.status(400).json({ error: 'A TPIN is 10 digits' });
    }
    if (b.branchId !== undefined) {
      if (!/^\d{3}$/.test(String(b.branchId || ''))) return res.status(400).json({ error: 'The branch ID is 3 digits, e.g. 000' });
      data.branchId = String(b.branchId);
    }
    if (b.deviceSerial !== undefined) data.deviceSerial = text(b.deviceSerial, 100);
    if (b.defaultTaxCategory !== undefined) {
      data.defaultTaxCategory = text(b.defaultTaxCategory, 5);
      if (data.defaultTaxCategory && !ZRA_TAX_CATEGORIES.hasOwnProperty(data.defaultTaxCategory)) return res.status(400).json({ error: `Tax category must be one of ${Object.keys(ZRA_TAX_CATEGORIES).join(', ')}` });
    }
    if (b.startDate !== undefined) {
      data.startDate = b.startDate ? new Date(`${String(b.startDate).slice(0, 10)}T00:00:00+02:00`) : null;
      if (data.startDate && isNaN(data.startDate)) return res.status(400).json({ error: 'Start date is not a date' });
    }
    if (b.originCountry !== undefined) {
      data.originCountry = text(b.originCountry, 2)?.toUpperCase() || null;
      if (data.originCountry && !/^[A-Z]{2}$/.test(data.originCountry)) return res.status(400).json({ error: 'Country of origin is a two-letter code, e.g. CN' });
    }
    for (const k of ['qtyUnitCode', 'pkgUnitCode']) if (b[k] !== undefined) data[k] = text(b[k], 10) || ZRA_DEFAULTS[k];
    for (const k of ['deliveryClassCode', 'refundReasonCode']) if (b[k] !== undefined) data[k] = text(b[k], 20);

    // Pointing at a different VSDC or taxpayer means starting again with ZRA: the device is
    // initialised afresh, every item is registered afresh, and nothing goes out until then.
    const merged = { ...ZRA_DEFAULTS, ...(existing || {}), ...data };
    const rekeyed = existing && ['vsdcUrl', 'tpin', 'branchId', 'deviceSerial'].some(k => data[k] !== undefined && data[k] !== existing[k]);
    if (rekeyed) {
      data.initialisedAt = null; data.deliveryRegisteredAt = null; merged.initialisedAt = null;
      await prisma.product.updateMany({ where: { companyId: company.id }, data: { zraRegisteredAt: null } });
    }
    if (b.enabled !== undefined) {
      if (b.enabled === true) {
        const problems = zra_configProblems(merged);
        if (problems.length) return res.status(400).json({ error: `Before switching it on, add ${problems.join(', ')}` });
      }
      data.enabled = b.enabled === true;
    } else if (rekeyed) data.enabled = false;

    const saved = await prisma.zraConfig.upsert({ where: { companyId: company.id }, update: data, create: { ...data, companyId: company.id } });
    console.log(JSON.stringify({ event: 'zra_config', companyId: company.id, by: req.user.id, enabled: saved.enabled, environment: saved.environment }));
    res.json(zraView(saved));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

// One-time hand-shake with ZRA for this TPIN, branch and device. Also the "test connection".
router.post('/companies/:id/zra/initialise', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const config = await prisma.zraConfig.findUnique({ where: { companyId: req.params.id } });
    if (!config) return res.status(404).json({ error: 'Save the Smart Invoice settings first' });
    const missing = zra_configProblems(config).filter(p => p !== 'initialising the device with ZRA');
    if (missing.length) return res.status(400).json({ error: `Add ${missing.join(', ')} first` });
    const r = await zra_post(config, '/initializer/selectInitInfo', { tpin: config.tpin, bhfId: config.branchId, dvcSrlNo: config.deviceSerial });
    // 902 is ZRA's "this device is already initialised", which is as good as a fresh one.
    const ok = r.ok || (r.reached && r.code === '902');
    if (!ok) return res.status(502).json({ error: r.error });
    const saved = await prisma.zraConfig.update({ where: { id: config.id }, data: { initialisedAt: new Date() } });
    res.json(zraView(saved));
  } catch (err) {
    if (err.constructor?.name === 'ZraProblem') return res.status(400).json({ error: err.message });
    console.error(err); res.status(500).json({ error: 'Something went wrong' });
  }
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
