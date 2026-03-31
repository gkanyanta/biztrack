const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// List customers
router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { search } = req.query;

    const where = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } }
      ];
    }

    const customers = await prisma.customer.findMany({
      where,
      include: { _count: { select: { sales: true } } },
      orderBy: { createdAt: 'desc' }
    });

    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single customer
router.get('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: { sales: { include: { product: true }, orderBy: { date: 'desc' } } }
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get customer orders
router.get('/:id/orders', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const sales = await prisma.sale.findMany({
      where: { customerId: req.params.id },
      include: { product: true },
      orderBy: { date: 'desc' }
    });
    res.json(sales);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create customer
router.post('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const customer = await prisma.customer.create({ data: req.body });
    res.status(201).json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update customer
router.put('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data: req.body
    });
    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete customer
router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.customer.delete({ where: { id: req.params.id } });
    res.json({ message: 'Customer deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
