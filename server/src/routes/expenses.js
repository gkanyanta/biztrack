const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// List expenses
router.get('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const { category, from, to } = req.query;

    const where = {};
    if (category) where.category = category;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to + 'T23:59:59.999Z');
    }

    const expenses = await prisma.expense.findMany({
      where,
      orderBy: { date: 'desc' }
    });

    res.json(expenses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create expense
router.post('/', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const data = { ...req.body };
    if (data.date) data.date = new Date(data.date);
    const expense = await prisma.expense.create({ data });
    res.status(201).json(expense);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update expense
router.put('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    const data = { ...req.body };
    if (data.date) data.date = new Date(data.date);
    const expense = await prisma.expense.update({
      where: { id: req.params.id },
      data
    });
    res.json(expense);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete expense
router.delete('/:id', async (req, res) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.expense.delete({ where: { id: req.params.id } });
    res.json({ message: 'Expense deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
