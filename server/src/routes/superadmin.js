const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { authenticate, requireSuperadmin } = require('../middleware/auth');

router.use(authenticate);
router.use(requireSuperadmin);

// Stats overview
router.get('/stats', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const totalCompanies = await prisma.company.count();
    const totalUsers = await prisma.user.count({ where: { role: 'admin' } });
    const newestCompany = await prisma.company.findFirst({ orderBy: { createdAt: 'desc' } });
    res.json({ totalCompanies, totalUsers, newestCompany });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List all companies
router.get('/companies', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companies = await prisma.company.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { users: true, products: true, sales: true } } },
    });
    res.json(companies);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get company detail with users
router.get('/companies/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const company = await prisma.company.findUnique({
      where: { id: req.params.id },
      include: {
        users: { select: { id: true, username: true, name: true, role: true, createdAt: true } },
        _count: { select: { products: true, sales: true, customers: true, expenses: true } },
      },
    });
    if (!company) return res.status(404).json({ error: 'Company not found' });
    res.json(company);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
