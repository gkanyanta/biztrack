const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    res.json(await prisma.shippingRate.findMany({ where: { companyId }, orderBy: { city: 'asc' } }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    res.status(201).json(await prisma.shippingRate.create({ data: { ...req.body, companyId } }));
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'City already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.shippingRate.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = { ...req.body };
    delete data.companyId;
    res.json(await prisma.shippingRate.update({ where: { id: req.params.id }, data }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const companyId = req.user.companyId;
    const existing = await prisma.shippingRate.findFirst({ where: { id: req.params.id, companyId } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await prisma.shippingRate.delete({ where: { id: req.params.id } });
    res.json({ message: 'Shipping rate deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
