const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { authenticate, requireAdmin } = require('../middleware/auth');

// Non-consultant staff logins (e.g. inventory/warehouse role). Kept separate from the
// Consultant-linked login flow since these users have no commission profile.
const ALLOWED_ROLES = ['inventory'];

router.use(authenticate);
router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const staff = await prisma.user.findMany({
      where: { companyId, role: { in: ALLOWED_ROLES } },
      select: { id: true, username: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(staff);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const { username, password, name, role } = req.body;
    if (!ALLOWED_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!username || typeof username !== 'string' || username.length < 3 || username.length > 50) return res.status(400).json({ error: 'Username must be 3-50 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    if (!password || typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return res.status(400).json({ error: 'Username already taken' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { username, password: hashed, name, role, companyId } });
    res.status(201).json({ id: user.id, username: user.username, name: user.name, role: user.role });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/:id/reset-password', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const staffUser = await prisma.user.findFirst({ where: { id: req.params.id, companyId, role: { in: ALLOWED_ROLES } } });
    if (!staffUser) return res.status(404).json({ error: 'Staff account not found' });
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hashed = await bcrypt.hash(password, 10);
    await prisma.user.update({ where: { id: staffUser.id }, data: { password: hashed } });
    res.json({ message: 'Password reset' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const staffUser = await prisma.user.findFirst({ where: { id: req.params.id, companyId, role: { in: ALLOWED_ROLES } } });
    if (!staffUser) return res.status(404).json({ error: 'Staff account not found' });
    await prisma.user.delete({ where: { id: staffUser.id } });
    res.json({ message: 'Staff account removed' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
