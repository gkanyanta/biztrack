const router = require('express').Router();
const { authenticate, requireAdmin } = require('../middleware/auth');

router.use(authenticate);

function parseBody(body) {
  const data = {};
  if (body.label !== undefined) data.label = body.label || null;
  if (body.periodStart !== undefined) data.periodStart = new Date(body.periodStart);
  if (body.periodEnd !== undefined) data.periodEnd = new Date(body.periodEnd + (body.periodEnd.length === 10 ? 'T23:59:59.999Z' : ''));
  if (body.revenueTarget !== undefined) data.revenueTarget = body.revenueTarget;
  if (body.savingsRate !== undefined) data.savingsRate = body.savingsRate;
  return data;
}

function validate(data, { partial } = { partial: false }) {
  if (!partial || data.periodStart !== undefined || data.periodEnd !== undefined) {
    if (!data.periodStart || !data.periodEnd || isNaN(data.periodStart) || isNaN(data.periodEnd)) return 'Valid periodStart and periodEnd are required';
    if (data.periodStart >= data.periodEnd) return 'periodStart must be before periodEnd';
  }
  if (!partial || data.revenueTarget !== undefined) {
    const n = parseFloat(data.revenueTarget);
    if (isNaN(n) || n < 0) return 'revenueTarget must be a non-negative number';
  }
  if (data.savingsRate !== undefined) {
    const r = parseFloat(data.savingsRate);
    if (isNaN(r) || r < 0 || r > 1) return 'savingsRate must be between 0 and 1';
  }
  return null;
}

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const targets = await prisma.salesTarget.findMany({ where: { companyId }, orderBy: { periodStart: 'desc' } });
    res.json(targets);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.get('/active', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const now = new Date();
    const matches = await prisma.salesTarget.findMany({ where: { companyId, periodStart: { lte: now }, periodEnd: { gte: now } } });
    if (!matches.length) return res.json(null);
    // Shortest period wins (most specific)
    matches.sort((a, b) => (a.periodEnd - a.periodStart) - (b.periodEnd - b.periodStart));
    res.json(matches[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const data = parseBody(req.body);
    const err = validate(data);
    if (err) return res.status(400).json({ error: err });
    const target = await prisma.salesTarget.create({ data: { ...data, companyId } });
    res.status(201).json(target);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.salesTarget.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = parseBody(req.body);
    const err = validate({ ...existing, ...data }, { partial: true });
    if (err) return res.status(400).json({ error: err });
    const target = await prisma.salesTarget.update({ where: { id: req.params.id }, data });
    res.json(target);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.salesTarget.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.salesTarget.delete({ where: { id: req.params.id } });
    res.json({ message: 'Target deleted' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Something went wrong' }); }
});

module.exports = router;
