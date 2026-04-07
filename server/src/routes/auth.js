const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

router.post('/register', async (req, res) => {
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

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, password: hashedPassword, name, role: 'admin', companyId: company.id }
    });

    const defaults = [
      { key: 'currency', value: 'ZMW', companyId: company.id },
      { key: 'businessName', value: companyName, companyId: company.id },
      { key: 'currencySymbol', value: 'K', companyId: company.id }
    ];
    for (const s of defaults) {
      await prisma.setting.create({ data: s });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, companyId: company.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role, companyId: company.id, companyName: company.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { username, password } = req.body;

    const user = await prisma.user.findUnique({ where: { username }, include: { company: true } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.company && !user.company.isActive) {
      return res.status(403).json({ error: 'Your company account has been suspended. Contact the system administrator.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, companyId: user.companyId },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, name: user.name, role: user.role, companyId: user.companyId, companyName: user.company?.name || null }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', require('../middleware/auth').authenticate, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { company: true }
    });
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username, name: user.name, role: user.role, companyId: user.companyId, companyName: user.company?.name || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
