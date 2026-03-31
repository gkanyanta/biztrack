const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const rates = await prisma.shippingRate.findMany({ orderBy: { city: 'asc' } });
    res.json(rates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const rate = await prisma.shippingRate.create({ data: req.body });
    res.status(201).json(rate);
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'City already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const rate = await prisma.shippingRate.update({
      where: { id: req.params.id },
      data: req.body
    });
    res.json(rate);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.shippingRate.delete({ where: { id: req.params.id } });
    res.json({ message: 'Shipping rate deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
